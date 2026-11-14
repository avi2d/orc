import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { listRuns, openDatabase, recordEvidence, recordRun, recordStep, updateRun } from "../../packages/run/src/entities/run-history/index"
import { readListedRuns, readRunsJsonRuns, readStepLog, runsJson, stepLogFile, titleOf } from "../../packages/run/src/features/seeing-runs/index"

const withDb = async (use: (home: string, db: Database) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-run-facts-"))
  const db = await Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))
  try {
    await use(home, db)
  } finally {
    db.close()
    await rm(home, { recursive: true, force: true })
  }
}

const run = async (db: Database, home: string, id: string, status: "running" | "failed", task: string): Promise<string> => {
  const runDir = join(home, "runs", id)
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, "task.md"), task)
  await Effect.runPromise(recordRun(db, { id, project: "/p/orc", branch: "orc/task-1", taskFile: join(runDir, "task.md"), status, started: "2026-11-13T10:00:00.000Z" }))
  return runDir
}

const listed = (db: Database) =>
  Effect.runPromise(listRuns(db).pipe(Effect.flatMap((runs) => readListedRuns(db, runs)), Effect.provide(BunServices.layer)))

const jsonRuns = (home: string, db: Database) =>
  Effect.runPromise(
    listRuns(db).pipe(
      Effect.flatMap((runs) => readListedRuns(db, runs)),
      Effect.flatMap((runs) => readRunsJsonRuns(runs, (runId) => join(home, "runs", runId))),
      Effect.map((runs) => runsJson(runs).runs),
      Effect.provide(BunServices.layer)
    )
  )

const asking = (count: number): string =>
  JSON.stringify({ asked: "2026-11-13T10:01:00.000Z", until: "2026-11-13T10:31:00.000Z", questions: Array.from({ length: count }, (_, index) => ({ id: "q" + index.toString(), text: "which one?" })) })

describe("titleOf", () => {
  test("a task file's markdown heading gives its words, not the hashes", () => {
    expect(titleOf("# Fix the gate\n\nThe gate stops.")).toBe("Fix the gate")
  })

  test("a task file that opens with blank lines takes its first written line, not an empty title", () => {
    expect(titleOf("\n\nWhy runs fail\nmore")).toBe("Why runs fail")
  })

  test("an empty task file has no title rather than an empty one", () => {
    expect(titleOf("\n  \n")).toBeNull()
  })
})

describe("readListedRuns", () => {
  test("a running run counts the questions asking.json holds instead of reading none", async () => {
    await withDb(async (home, db) => {
      const runDir = await run(db, home, "run-a", "running", "# Ask twice\n")
      await writeFile(join(runDir, "asking.json"), asking(2))
      const [entry] = await listed(db)
      expect(entry.questions).toBe(2)
      expect(entry.title).toBe("Ask twice")
    })
  })

  test("a failed run with a leftover asking.json waits on nobody", async () => {
    await withDb(async (home, db) => {
      const runDir = await run(db, home, "run-b", "failed", "# Ended\n")
      await writeFile(join(runDir, "asking.json"), asking(1))
      const [entry] = await listed(db)
      expect(entry.questions).toBe(0)
    })
  })

  test("the running step is where the run is now, not a step that started later and ended", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-c", "running", "# Steps\n")
      await Effect.runPromise(recordStep(db, { runId: "run-c", name: "fix", attempt: 1, status: "running", started: "2026-11-13T10:02:00.000Z" }))
      await Effect.runPromise(recordStep(db, { runId: "run-c", name: "checks", attempt: 1, status: "failed", started: "2026-11-13T10:03:00.000Z", ended: "2026-11-13T10:04:00.000Z" }))
      const [entry] = await listed(db)
      expect(entry.step).toMatchObject({ name: "fix", attempt: 1, status: "running" })
    })
  })

  test("a run with no steps yet says so instead of borrowing another run's step", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-d", "running", "# Fresh\n")
      await run(db, home, "run-e", "failed", "# Other\n")
      await Effect.runPromise(recordStep(db, { runId: "run-e", name: "implement", attempt: 1, status: "failed", started: "2026-11-13T10:02:00.000Z" }))
      const entries = await listed(db)
      expect(entries.find((entry) => entry.run.id === "run-d")?.step).toBeNull()
    })
  })
})

describe("readRunsJsonRuns", () => {
  test("a running run reads waiting while asking.json stands and running once it is removed, not running throughout", async () => {
    await withDb(async (home, db) => {
      const runDir = await run(db, home, "run-w", "running", "# Ask\n")
      expect((await jsonRuns(home, db))[0]?.state).toBe("running")
      await writeFile(join(runDir, "asking.json"), asking(1))
      expect((await jsonRuns(home, db))[0]?.state).toBe("waiting")
      await unlink(join(runDir, "asking.json"))
      expect((await jsonRuns(home, db))[0]?.state).toBe("running")
    })
  })

  test("an ended run reads its outcome even beside a leftover asking.json, and a stopped run reads failed rather than stopped", async () => {
    await withDb(async (home, db) => {
      const succeededDir = await run(db, home, "run-s", "running", "# Done\n")
      await run(db, home, "run-t", "running", "# Stopped\n")
      await run(db, home, "run-u", "failed", "# Failed\n")
      await writeFile(join(succeededDir, "asking.json"), asking(1))
      await Effect.runPromise(updateRun(db, "run-s", { status: "succeeded", ended: "2026-11-13T10:09:00.000Z", prLink: null, endReason: null }))
      await Effect.runPromise(updateRun(db, "run-t", { status: "stopped", ended: "2026-11-13T10:09:00.000Z", prLink: null, endReason: null }))
      const states = Object.fromEntries((await jsonRuns(home, db)).map((entry) => [entry.id, entry.state]))
      expect(states).toEqual({ "run-s": "succeeded", "run-t": "failed", "run-u": "failed" })
    })
  })

  test("currentStep names the running step's attempt rather than the first attempt or a later ended step, and is null once the run ends", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-c", "running", "# Steps\n")
      expect((await jsonRuns(home, db))[0]?.currentStep).toBeNull()
      await Effect.runPromise(recordStep(db, { runId: "run-c", name: "fix", attempt: 1, status: "failed", started: "2026-11-13T10:01:00.000Z", ended: "2026-11-13T10:02:00.000Z" }))
      await Effect.runPromise(recordStep(db, { runId: "run-c", name: "fix", attempt: 2, status: "running", started: "2026-11-13T10:03:00.000Z" }))
      await Effect.runPromise(recordStep(db, { runId: "run-c", name: "checks", attempt: 1, status: "passed", started: "2026-11-13T10:04:00.000Z", ended: "2026-11-13T10:05:00.000Z" }))
      expect((await jsonRuns(home, db))[0]?.currentStep).toEqual({ name: "fix", attempt: 2 })
      await Effect.runPromise(updateRun(db, "run-c", { status: "failed", ended: "2026-11-13T10:06:00.000Z", prLink: null, endReason: null }))
      expect((await jsonRuns(home, db))[0]?.currentStep).toBeNull()
    })
  })
})

describe("stepLogFile", () => {
  test("the implement step reads agent.log, not its JSON session file", () => {
    expect(stepLogFile("/r", { name: "implement", attempt: 1, status: "running", out: [{ kind: "session", path: "/r/sessions/s.jsonl" }] })).toBe("/r/agent.log")
  })

  test("a fix step reads its own attempt's log, not the first fix's", () => {
    expect(stepLogFile("/r", { name: "fix", attempt: 2, status: "running", out: [] })).toBe("/r/fix-2.log")
  })

  test("a checks step reads the file it wrote, not a session beside it", () => {
    expect(stepLogFile("/r", { name: "checks", attempt: 3, status: "failed", out: [{ kind: "checks", path: "/r/session/checks-3.txt" }, { kind: "session", path: "/r/s.jsonl" }] })).toBe("/r/session/checks-3.txt")
  })

  test("an inherited implement step reads the prior run log recorded as evidence", () => {
    expect(stepLogFile("/new", { name: "implement", attempt: 1, status: "passed", out: [{ kind: "evidence", path: "/new/implement-1.md" }, { kind: "session", path: "/new/s.jsonl" }, { kind: "log", path: "/prior/agent.log" }] })).toBe("/prior/agent.log")
  })

  test("an inherited fix step reads its prior log, not the session beside it", () => {
    expect(stepLogFile("/new", { name: "fix", attempt: 2, status: "failed", out: [{ kind: "session", path: "/prior/s.jsonl" }, { kind: "log", path: "/prior/fix-2.log" }] })).toBe("/prior/fix-2.log")
  })

  test("a running checks step with no evidence reads the live session checks file", () => {
    expect(stepLogFile("/r", { name: "checks", attempt: 1, status: "running", out: [] })).toBe("/r/session/checks-1.txt")
  })
})

describe("readStepLog", () => {
  test("prints a failed checks round's output as written", async () => {
    await withDb(async (home, db) => {
      const runDir = await run(db, home, "run-f", "running", "# Checks\n")
      const stepId = await Effect.runPromise(recordStep(db, { runId: "run-f", name: "checks", attempt: 1, status: "failed", started: "2026-11-13T10:02:00.000Z" }))
      await writeFile(join(runDir, "checks-1.txt"), "test: 1 failed\nexpected 2, got 3\n")
      await Effect.runPromise(recordEvidence(db, { stepId, direction: "out", path: join(runDir, "checks-1.txt"), kind: "checks" }))
      const text = await Effect.runPromise(readStepLog(db, "run-f", stepId).pipe(Effect.provide(BunServices.layer)))
      expect(text).toBe("test: 1 failed\nexpected 2, got 3\n")
    })
  })

  test("an agent step whose log is not written yet reads empty instead of failing", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-g", "running", "# Agent\n")
      const stepId = await Effect.runPromise(recordStep(db, { runId: "run-g", name: "implement", attempt: 1, status: "running", started: "2026-11-13T10:02:00.000Z" }))
      const text = await Effect.runPromise(readStepLog(db, "run-g", stepId).pipe(Effect.provide(BunServices.layer)))
      expect(text).toBe("")
    })
  })

  test("a step of another run is refused rather than read", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-h", "running", "# One\n")
      await run(db, home, "run-i", "running", "# Two\n")
      const stepId = await Effect.runPromise(recordStep(db, { runId: "run-i", name: "implement", attempt: 1, status: "running", started: "2026-11-13T10:02:00.000Z" }))
      const error = await Effect.runPromise(Effect.flip(readStepLog(db, "run-h", stepId).pipe(Effect.provide(BunServices.layer))))
      expect(error["_tag"]).toBe("UnknownStep")
    })
  })

  test("a resumed implement step shows the prior run log, not the session", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-j", "running", "# Agent\n")
      const priorDir = join(home, "runs", "prior-1")
      await mkdir(priorDir, { recursive: true })
      await writeFile(join(priorDir, "agent.log"), "prior output\n")
      await writeFile(join(priorDir, "s.jsonl"), "{\"type\":\"session\"}\n")
      const stepId = await Effect.runPromise(recordStep(db, { runId: "run-j", name: "implement", attempt: 1, status: "passed", started: "2026-11-13T10:02:00.000Z" }))
      await Effect.runPromise(recordEvidence(db, { stepId, direction: "out", path: join(priorDir, "s.jsonl"), kind: "session" }))
      await Effect.runPromise(recordEvidence(db, { stepId, direction: "out", path: join(priorDir, "agent.log"), kind: "log" }))
      const text = await Effect.runPromise(readStepLog(db, "run-j", stepId).pipe(Effect.provide(BunServices.layer)))
      expect(text).toBe("prior output\n")
    })
  })

  test("a passed step with no log anywhere is refused instead of reading empty", async () => {
    await withDb(async (home, db) => {
      await run(db, home, "run-k", "failed", "# Agent\n")
      const stepId = await Effect.runPromise(recordStep(db, { runId: "run-k", name: "implement", attempt: 1, status: "failed", started: "2026-11-13T10:02:00.000Z" }))
      const error = await Effect.runPromise(Effect.flip(readStepLog(db, "run-k", stepId).pipe(Effect.provide(BunServices.layer))))
      expect(error["_tag"]).toBe("NoStepLog")
    })
  })

  test("a running checks step reads the live session checks file", async () => {
    await withDb(async (home, db) => {
      const runDir = await run(db, home, "run-l", "running", "# Checks\n")
      const stepId = await Effect.runPromise(recordStep(db, { runId: "run-l", name: "checks", attempt: 1, status: "running", started: "2026-11-13T10:02:00.000Z" }))
      await mkdir(join(runDir, "session"), { recursive: true })
      await writeFile(join(runDir, "session", "checks-1.txt"), "check a: running\n")
      const text = await Effect.runPromise(readStepLog(db, "run-l", stepId).pipe(Effect.provide(BunServices.layer)))
      expect(text).toBe("check a: running\n")
    })
  })
})
