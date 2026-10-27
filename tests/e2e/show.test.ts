import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { openDatabase, recordEvidence, recordRun, recordScore, recordSignal, recordStep } from "../../packages/run/src/run-history"
import { decodeShowJson } from "../../packages/run/src/show"

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

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(join(home, ".orc")).pipe(Effect.provide(BunServices.layer)))

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-show-e2e-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const fixture = async (db: Database): Promise<void> => {
  await Effect.runPromise(recordRun(db, {
    id: "show-1",
    project: "orc",
    branch: "orc/demo",
    taskFile: "/tmp/show-home/runs/show-1/task.md",
    status: "succeeded",
    started: "2026-10-18T10:00:00.000Z",
    ended: "2026-10-18T10:05:00.000Z",
    prLink: "https://github.com/avi2d/orc/pull/7",
    endReason: "done"
  }))
  const implement = await Effect.runPromise(recordStep(db, {
    runId: "show-1",
    name: "implement",
    attempt: 1,
    status: "passed",
    started: "2026-10-18T10:00:00.000Z",
    ended: "2026-10-18T10:01:00.000Z",
    agentFile: "bundled/implementer.md",
    piSessionFile: "/tmp/show-home/runs/show-1/sessions/x.jsonl"
  }))
  await Effect.runPromise(recordEvidence(db, { stepId: implement, direction: "out", path: "/tmp/show-home/runs/show-1/implement-1.md", kind: "evidence" }))
  await Effect.runPromise(recordSignal(db, { stepId: implement, name: "commit-count", value: "2" }))
  await Effect.runPromise(recordScore(db, { stepId: implement, score: 4, note: "good", scoredAt: "2026-10-18T11:00:00.000Z" }))
}

describe("orc show", () => {
  test("a recorded run prints its steps, signals, score and file links", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
      } finally {
        db.close()
      }
      const result = await runOrc(["show", "show-1"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("step implement #1: passed")
      expect(result.stdout).toContain("signal commit-count: 2")
      expect(result.stdout).toContain("score: 4 good (2026-10-18T11:00:00.000Z)")
      expect(result.stdout).toContain("file:///tmp/show-home/runs/show-1/task.md")
      expect(result.stdout).toContain("file:///tmp/show-home/runs/show-1/report.md")
      expect(result.stdout).toContain("file:///tmp/show-home/runs/show-1/implement-1.md")
      expect(result.stdout).toContain("https://github.com/avi2d/orc/pull/7")
    })
  })

  test("show --json prints the version first and reads back through the schema", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
      } finally {
        db.close()
      }
      const result = await runOrc(["show", "show-1", "--json"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.startsWith('{"schema":"orc.show.v1"')).toBe(true)
      const decoded = await Effect.runPromise(decodeShowJson(JSON.parse(result.stdout)))
      expect(decoded.run).toMatchObject({ id: "show-1", branch: "orc/demo", status: "succeeded" })
      expect(decoded.steps.map((step) => step.name)).toEqual(["implement"])
    })
  })

  test("an unknown run id fails naming the run", async () => {
    await withHome(async (home) => {
      const result = await runOrc(["show", "missing"], home)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("orc: unknown run missing")
    })
  })

  test("a missing run id prints the usage", async () => {
    await withHome(async (home) => {
      const result = await runOrc(["show"], home)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("orc show <run> [--json]")
    })
  })
})
