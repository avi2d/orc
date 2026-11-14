import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import type { Database } from "bun:sqlite"
import { openDatabase, recordEvidence, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"

interface OrcResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const runOrc = async (args: ReadonlyArray<string>, home: string): Promise<OrcResult> => {
  const proc = Bun.spawn([process.execPath, "packages/run/src/bin.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, ORC_HOME: "" }
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

const machineRun = {
  id: "run-9",
  project: "orc",
  branch: "orc/orc-40",
  status: "succeeded",
  state: "succeeded",
  prLink: "https://github.com/avi2d/orc/pull/9",
  title: "Remote task",
  step: null,
  currentStep: null,
  questions: 0,
  endReason: null,
  kind: "ship",
  delivery: "no-mistakes",
  task: "orc-40",
  machine: "box",
  worktree: "/work/orc-40"
}

const recordLocalRun = async (home: string): Promise<void> => {
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
}

// The fake machine stands in for the command that reaches another machine: it records its argv and prints or fails as told.
const writeFakeMachine = async (home: string, answer: { readonly stdout: string; readonly stderr?: string; readonly status?: number }) => {
  const script = join(home, "fake-machine.sh")
  const argv = join(home, "argv.txt")
  const stdoutFile = join(home, "answer.txt")
  await writeFile(stdoutFile, answer.stdout)
  const lines = [
    "#!/bin/sh",
    `echo "$*" > '${argv}'`,
    ...(answer.stderr === undefined ? [] : [`printf '%s\\n' '${answer.stderr}' >&2`]),
    `cat '${stdoutFile}'`,
    `exit ${answer.status ?? 0}`
  ]
  await writeFile(script, lines.join("\n") + "\n")
  return { script, argv }
}

const writeDispatch = async (home: string, start: ReadonlyArray<string>): Promise<void> => {
  await mkdir(join(home, ".orc", "backlog"), { recursive: true })
  const dispatch = {
    machines: [{ name: "box", slots: 1, start }],
    quota: { provider: "example", command: ["example-quota"], accounts: [{ name: "main", kind: "none" }] }
  }
  await writeFile(join(home, ".orc", "backlog", "dispatch.json"), JSON.stringify(dispatch))
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
      const printed = Schema.decodeUnknownSync(Schema.Struct({ runs: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }))(JSON.parse(result.stdout))
      expect(Object.keys(printed.runs[0] ?? {}).sort()).toEqual(["branch", "currentStep", "delivery", "endReason", "id", "kind", "machine", "prLink", "project", "questions", "state", "status", "step", "task", "title", "worktree"])
      expect(printed.runs[0]).toMatchObject({ id: "run-1", project: "orc", branch: "orc/x", status: "running", state: "running", currentStep: null })
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

  test("orc log prints a failed checks round's output as written, not its session file", async () => {
    await withHome(async (home) => {
      const runDir = join(home, ".orc", "runs", "run-1")
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, "checks-1.txt"), "lint: 2 errors\n")
      await writeFile(join(runDir, "session.jsonl"), "{}\n")
      const db = await openDb(home)
      let stepId = 0
      try {
        Effect.runSync(recordRun(db, { id: "run-1", project: "orc", branch: "orc/x", taskFile: join(runDir, "task.md"), status: "running", started: "2026-10-18T10:00:00.000Z" }))
        stepId = Effect.runSync(recordStep(db, { runId: "run-1", name: "checks", attempt: 1, status: "failed", started: "2026-10-18T10:01:00.000Z" }))
        Effect.runSync(recordEvidence(db, { stepId, direction: "out", path: join(runDir, "checks-1.txt"), kind: "checks" }))
        Effect.runSync(recordEvidence(db, { stepId, direction: "out", path: join(runDir, "session.jsonl"), kind: "session" }))
      } finally {
        db.close()
      }
      const result = await runOrc(["log", "run-1", stepId.toString()], home)
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("lint: 2 errors\n")
    })
  })

  test("orc log names an unknown run on stderr instead of printing nothing", async () => {
    await withHome(async (home) => {
      const result = await runOrc(["log", "nope", "1"], home)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: unknown run nope\n")
    })
  })

  test("runs --json adds the runs another dispatch machine answers with to the list", async () => {
    await withHome(async (home) => {
      await recordLocalRun(home)
      const fake = await writeFakeMachine(home, { stdout: JSON.stringify({ schema: "orc.runs.v1", runs: [machineRun], machines: [] }) })
      await writeDispatch(home, ["orc", "runner", "start", "--", "sh", fake.script])
      const result = await runOrc(["runs", "--json"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(await readFile(fake.argv, "utf8")).toBe("runs --json --local\n")
      const document = JSON.parse(result.stdout)
      expect(document.runs.map((run: { readonly id: string }) => run.id)).toEqual(["run-1", "run-9"])
      expect(document.runs[1]).toEqual(machineRun)
      expect(document.machines).toEqual([])
    })
  })

  test("a dispatch machine that fails is named in machines with its error while the local runs still print", async () => {
    await withHome(async (home) => {
      await recordLocalRun(home)
      const fake = await writeFakeMachine(home, { stdout: "", stderr: "orc: not installed", status: 3 })
      await writeDispatch(home, ["orc", "runner", "start", "--", "sh", fake.script])
      const result = await runOrc(["runs", "--json"], home)
      expect(result.exitCode).toBe(0)
      const document = JSON.parse(result.stdout)
      expect(document.runs.map((run: { readonly id: string }) => run.id)).toEqual(["run-1"])
      expect(document.machines).toHaveLength(1)
      expect(document.machines[0].machine).toBe("box")
      expect(document.machines[0].error).toContain("exited 3")
      expect(document.machines[0].error).toContain("orc: not installed")
    })
  })

  test("a dispatch machine that prints JSON orc cannot read is named in machines and adds no runs", async () => {
    await withHome(async (home) => {
      await recordLocalRun(home)
      const fake = await writeFakeMachine(home, { stdout: JSON.stringify({ schema: "orc.runs.v1", runs: [{ id: "run-9" }], machines: [] }) })
      await writeDispatch(home, ["orc", "runner", "start", "--", "sh", fake.script])
      const result = await runOrc(["runs", "--json"], home)
      expect(result.exitCode).toBe(0)
      const document = JSON.parse(result.stdout)
      expect(document.runs.map((run: { readonly id: string }) => run.id)).toEqual(["run-1"])
      expect(document.machines).toHaveLength(1)
      expect(document.machines[0].machine).toBe("box")
      expect(document.machines[0].error).toContain("JSON orc cannot read")
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
