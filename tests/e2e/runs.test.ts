import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import type { Database } from "bun:sqlite"
import { openDatabase, recordRun } from "../../packages/run/src/run-history"

interface OrcResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const runOrc = async (args: ReadonlyArray<string>, home: string): Promise<OrcResult> => {
  const proc = Bun.spawn([process.execPath, "packages/run/src/bin.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home }
  })
  const stdout = proc.stdout
  const stderr = proc.stderr
  if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
    throw new Error("the orc process has no piped output")
  }
  const [out, err, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), proc.exited])
  return { exitCode, stdout: out, stderr: err }
}

const RunsDocument = Schema.Struct({
  schema: Schema.Literal("orc.runs.v1"),
  runs: Schema.Array(Schema.Struct({
    id: Schema.String,
    project: Schema.String,
    branch: Schema.String,
    status: Schema.String,
    prLink: Schema.NullOr(Schema.String)
  }))
})

const concurrentOpens = 8
const concurrentOpenRounds = 6

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(join(home, ".orc")).pipe(Effect.provide(BunServices.layer)))

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-runs-e2e-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe("orc runs", () => {
  test("a fresh home lists no runs and gains ~/.orc/orc.sqlite", async () => {
    await withHome(async (home) => {
      const result = await runOrc(["runs"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("no runs recorded")
      expect((await stat(join(home, ".orc", "orc.sqlite"))).isFile()).toBe(true)
    })
  })

  test("concurrent first opens of a fresh home all list runs instead of one finding the history locked", async () => {
    for (let round = 0; round < concurrentOpenRounds; round += 1) {
      await withHome(async (home) => {
        const results = await Promise.all(Array.from({ length: concurrentOpens }, () => runOrc(["runs"], home)))
        expect(results.map((result) => result.stderr)).toEqual(results.map(() => ""))
        expect(results.map((result) => result.exitCode)).toEqual(results.map(() => 0))
      })
    }
  }, 60_000)

  test("a corrupt history file is reported on stderr with a non-zero exit", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, ".orc"))
      await writeFile(join(home, ".orc", "orc.sqlite"), "this is not a sqlite database ".repeat(8))
      for (const args of [["runs"], ["runs", "--json"]]) {
        const result = await runOrc(args, home)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("orc: cannot read the run history: file is not a database\n")
      }
    })
  })

  test("lists recorded runs with their project, branch, status and PR link", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        Effect.runSync(recordRun(db, {
          id: "run-1",
          project: "orc",
          branch: "orc/x",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-18T10:00:00.000Z",
          ended: "2026-10-18T10:05:00.000Z",
          prLink: "https://github.com/avi2d/orc/pull/1"
        }))
      } finally {
        db.close()
      }
      const result = await runOrc(["runs"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("orc/x")
      expect(result.stdout).toContain("succeeded")
      expect(result.stdout).toContain("https://github.com/avi2d/orc/pull/1")
    })
  })

  test("runs --json prints the version first and the listed facts", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        Effect.runSync(recordRun(db, {
          id: "run-1",
          project: "orc",
          branch: "orc/x",
          taskFile: "task.md",
          status: "running",
          started: "2026-10-18T10:00:00.000Z"
        }))
      } finally {
        db.close()
      }
      const result = await runOrc(["runs", "--json"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.startsWith('{"schema":"orc.runs.v1"')).toBe(true)
      const document = Schema.decodeUnknownSync(RunsDocument)(JSON.parse(result.stdout))
      expect(Object.keys(document)[0]).toBe("schema")
      expect(document.schema).toBe("orc.runs.v1")
      expect(document.runs).toHaveLength(1)
      expect(Object.keys(document.runs[0] ?? {}).sort()).toEqual(["branch", "id", "prLink", "project", "status"])
      expect(document.runs[0]).toMatchObject({ id: "run-1", project: "orc", branch: "orc/x", status: "running" })
    })
  })

  test("runs --json on a fresh home prints an empty versioned document", async () => {
    await withHome(async (home) => {
      const result = await runOrc(["runs", "--json"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.startsWith('{"schema":"orc.runs.v1"')).toBe(true)
      const document = Schema.decodeUnknownSync(RunsDocument)(JSON.parse(result.stdout))
      expect(Object.keys(document)[0]).toBe("schema")
      expect(document.schema).toBe("orc.runs.v1")
      expect(document.runs).toEqual([])
    })
  })

  test("an unknown runs flag prints usage and exits non-zero", async () => {
    await withHome(async (home) => {
      const result = await runOrc(["runs", "--frobnicate"], home)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("Usage: orc")
    })
  })
})
