import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { openDatabase, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"
import { buildResumePlan, resolveSandboxKind, resolveTaskFile } from "../../packages/run/src/features/running-a-task/run-resume"
import type { SandboxKind } from "../../packages/run/src/shared/sandbox/sandbox-kind"
import { recordChecksDone, recordChecksStart, recordFixStart, recordResumePublish } from "../../packages/run/src/features/running-a-task/history-write"
import { readStepLog } from "../../packages/run/src/features/seeing-runs/step-log"
import { subprocessNoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"

const implementer: AgentFile = {
  kind: "implementer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read"],
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
}

const fixer: AgentFile = {
  kind: "fixer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read"],
  body: "Fix the failure.",
  path: "bundled/fixer.md",
  source: "bundled"
}

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-resume-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const historyFor = (runId: string, home: string, projectDir: string, started: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runDir = path.join(home, "runs", runId)
    const run: HistoryRun = {
      fs, path, spawner, git: "git", projectDir, runId, runDir,
      piSessionDir: path.join(runDir, "session"),
      hostSessionsDir: path.join(runDir, "sessions"),
      taskPath: path.join(runDir, "task.md"),
      instructions: null,
      agent: implementer, fixer, branch: "orc/test", sandbox: "nono", started,
      worktreeDir: projectDir,
      delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git: "git", worktreeDir: projectDir }) },
      allow: [], answers: []
    }
    return run
  }).pipe(Effect.provide(BunServices.layer))

const seedRun = (db: Database, id: string, project: string, taskFile: string, status: "running" | "failed", started: string): Promise<void> =>
  Effect.runPromise(recordRun(db, { id, project, branch: "orc/test", taskFile, status, started }).pipe(Effect.asVoid))

const seedSandboxRun = (db: Database, id: string, project: string, sandbox: SandboxKind | null): Promise<void> =>
  Effect.runPromise(recordRun(db, { id, project, branch: "orc/test", taskFile: "task.md", status: "failed", started: "2026-10-19T09:00:00.000Z", sandbox }).pipe(Effect.asVoid))

const sandboxOutcome = (db: Database, project: string, flag: SandboxKind | undefined): Promise<string> =>
  Effect.runPromise(
    resolveSandboxKind(db, "orc/test", project, flag).pipe(
      Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message))
    )
  )

const RecordedSandboxRow = Schema.Struct({ sandbox: Schema.NullOr(Schema.String) })

const recordedSandbox = (db: Database, runId: string): string | null =>
  Schema.decodeUnknownSync(RecordedSandboxRow)(db.query("SELECT sandbox FROM runs WHERE id = ?").get(runId)).sandbox

const seedStep = (db: Database, runId: string, name: string, status: "running" | "passed" | "failed", started: string, piSessionFile: string | null): Promise<void> =>
  Effect.runPromise(recordStep(db, { runId, name, attempt: 1, status, started, agentFile: implementer.path, piSessionFile }).pipe(Effect.asVoid))

const writeSession = async (dir: string, name: string, id: string, mtime: Date): Promise<string> => {
  await mkdir(dir, { recursive: true })
  const file = join(dir, name + "_" + id + ".jsonl")
  await writeFile(file, JSON.stringify({ type: "session", id }) + "\n")
  await utimes(file, mtime, mtime)
  return file
}

const taskOutcome = (db: Database, project: string, supplied: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* resolveTaskFile(db, fs, "orc/test", project, supplied).pipe(
        Effect.as("resumed"),
        Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message))
      )
    }).pipe(Effect.provide(BunServices.layer))
  )

describe("resume recovers an interrupted agent from its live session", () => {
  test("a pinned parked run cannot restart implementation from missing or different history", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        const taskFile = join(priorDir, "task.md")
        await writeFile(taskFile, "Keep the output contract.\n")
        const run = { ...await Effect.runPromise(historyFor("next-1", home, project, "2026-11-13T12:00:00.000Z")), resumeRun: "prior-1", answers: [{ question: "R1", answer: "Keep it" }] }
        expect((await Effect.runPromise(Effect.flip(buildResumePlan(db, run)))).message).toContain("cannot resume prior-1")
        await seedRun(db, "prior-1", project, taskFile, "failed", "2026-11-13T10:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "passed", "2026-11-13T10:01:00.000Z", null)
        await seedStep(db, "prior-1", "checks", "passed", "2026-11-13T10:02:00.000Z", null)
        expect(await Effect.runPromise(buildResumePlan(db, run))).toMatchObject({
          skipImplement: true, skipChecks: true, answers: [{ question: "R1", answer: "Keep it" }]
        })
        await seedRun(db, "another-run", project, taskFile, "failed", "2026-11-13T11:00:00.000Z")
        expect((await Effect.runPromise(Effect.flip(buildResumePlan(db, run)))).message).toContain("cannot resume prior-1")
      } finally {
        db.close()
      }
    })
  })

  test("an interrupted implementation resumes the session still only in the agent sessions directory", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "running", "2026-10-19T09:00:00.000Z", null)
        const liveId = "aaa111"
        await writeSession(join(priorDir, "session", "agent", "sessions", "enc"), "2026-10-19T09-30-00-000Z", liveId, new Date("2026-10-19T09:30:00.000Z"))
        const run = await Effect.runPromise(historyFor("next-1", home, project, "2026-10-19T10:00:00.000Z"))
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.implementSessionId).toBe(liveId)
        expect(plan.skipImplement).toBe(false)
        expect(plan.fixSessionId).toBeNull()
        expect(dirname(plan.implementSessionFile ?? "")).toBe(join(home, "runs", "next-1", "sessions"))
        expect(plan.implementSessionFile ?? "").toContain(liveId)
      } finally {
        db.close()
      }
    })
  })

  test("an interrupted implementation whose recorded session Pi never wrote starts fresh instead of resuming a missing file", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        const unwritten = join(priorDir, "session", "agent", "sessions", "enc", "2026-10-19T09-00-01-000Z_bbb222.jsonl")
        await seedStep(db, "prior-1", "implement", "running", "2026-10-19T09:00:00.000Z", unwritten)
        const run = await Effect.runPromise(historyFor("next-1", home, project, "2026-10-19T10:00:00.000Z"))
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.skipImplement).toBe(false)
        expect(plan.implementSessionFile).toBeNull()
        expect(plan.implementSessionId).toBeNull()
      } finally {
        db.close()
      }
    })
  })

  test("an interrupted fixer resumes its own live session instead of the completed implementation export", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        const exportDir = join(priorDir, "sessions", "enc")
        const implementId = "aaa111"
        const fixId = "bbb222"
        const implementExport = await writeSession(exportDir, "2026-10-19T09-10-00-000Z", implementId, new Date("2026-10-19T09:10:00.000Z"))
        const liveDir = join(priorDir, "session", "agent", "sessions", "enc")
        await writeSession(liveDir, "2026-10-19T09-10-00-000Z", implementId, new Date("2026-10-19T09:10:00.000Z"))
        await writeSession(liveDir, "2026-10-19T09-40-00-000Z", fixId, new Date("2026-10-19T09:40:00.000Z"))
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "passed", "2026-10-19T09:00:00.000Z", implementExport)
        await seedStep(db, "prior-1", "fix", "running", "2026-10-19T09:35:00.000Z", null)
        const run = await Effect.runPromise(historyFor("next-1", home, project, "2026-10-19T10:00:00.000Z"))
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.skipImplement).toBe(true)
        expect(plan.implementSessionId).toBe(implementId)
        expect(plan.fixSessionId).toBe(fixId)
        expect(plan.fixSessionId ?? "").not.toContain("/")
        expect(dirname(plan.fixSessionFile ?? "")).toBe(join(home, "runs", "next-1", "sessions"))
        expect(plan.fixSessionFile ?? "").toContain(fixId)
      } finally {
        db.close()
      }
    })
  })

  test("a carried nono session header points at the new worktree instead of keeping the old checkout", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const worktree = join(home, "wt")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "running", "2026-10-19T09:00:00.000Z", null)
        const liveId = "ddd444"
        const liveDir = join(priorDir, "session", "agent", "sessions", "enc")
        await mkdir(liveDir, { recursive: true })
        const header = { type: "session", version: 3, id: liveId, timestamp: "2026-10-19T09:30:00.000Z", cwd: project }
        await writeFile(join(liveDir, "2026-10-19T09-30-00-000Z_" + liveId + ".jsonl"), JSON.stringify(header) + "\n")
        const base = await Effect.runPromise(historyFor("next-1", home, project, "2026-10-19T10:00:00.000Z"))
        const run = { ...base, worktreeDir: worktree }
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.implementSessionId).toBe(liveId)
        const carried = await readFile(plan.implementSessionFile ?? "", "utf-8")
        const carriedHeader: unknown = JSON.parse(carried.split("\n")[0])
        expect(typeof carriedHeader === "object" && carriedHeader !== null && "cwd" in carriedHeader ? carriedHeader.cwd : undefined).toBe(worktree)
      } finally {
        db.close()
      }
    })
  })

  test("an interrupted implementation resumes the session Pi wrote one folder below sessions and carries it into the next run's sessions instead of starting fresh", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "running", "2026-10-19T09:00:00.000Z", null)
        const liveId = "ccc333"
        const sessionDir = join(priorDir, "sessions", "host")
        await writeSession(sessionDir, "2026-10-19T09-30-00-000Z", liveId, new Date("2026-10-19T09:30:00.000Z"))
        const run = await Effect.runPromise(historyFor("next-1", home, project, "2026-10-19T10:00:00.000Z"))
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.implementSessionId).toBe(liveId)
        expect(plan.skipImplement).toBe(false)
        expect(dirname(plan.implementSessionFile ?? "")).toBe(join(home, "runs", "next-1", "sessions"))
        expect(plan.implementSessionFile ?? "").toContain(liveId)
      } finally {
        db.close()
      }
    })
  })
})

describe("resume binds task selection to the saved intent", () => {
  test("an unfinished implementation refuses a changed task file", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "running", "2026-10-19T09:00:00.000Z", null)
        const changed = join(home, "changed.md")
        await writeFile(changed, "Do the other thing.\n")
        expect(await taskOutcome(db, project, changed)).toContain("refuses")
      } finally {
        db.close()
      }
    })
  })

  test("a failed implementation refuses a changed task file", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "failed", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "failed", "2026-10-19T09:00:00.000Z", null)
        const changed = join(home, "changed.md")
        await writeFile(changed, "Do the other thing.\n")
        expect(await taskOutcome(db, project, changed)).toContain("refuses")
      } finally {
        db.close()
      }
    })
  })

  test("a run with no recorded steps accepts a changed task file", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        const changed = join(home, "changed.md")
        await writeFile(changed, "Do the other thing.\n")
        expect(await taskOutcome(db, project, changed)).toBe("resumed")
      } finally {
        db.close()
      }
    })
  })

describe("reinterrupted continuations survive every handover", () => {
  test("restarted Checks evidence does not land on the inherited row", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const run = await Effect.runPromise(historyFor("b", home, join(home, "repo"), "2026-10-19T10:00:00.000Z"))
        await seedRun(db, "b", run.projectDir, run.taskPath, "failed", run.started)
        const old = { round: 1, file: "/old.txt", started: run.started, ended: run.started, passed: false, failed: [], checks: [], refusals: [] }
        await Effect.runPromise(recordChecksDone(db, "b", old))
        await Effect.runPromise(recordChecksStart(db, "b", 1, run.started))
        await Effect.runPromise(recordChecksDone(db, "b", { ...old, file: "/new.txt", passed: true }))
        const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ status: Schema.String, path: Schema.String })))(db.query("SELECT steps.status, evidence.path FROM steps JOIN evidence ON evidence.step_id = steps.id WHERE steps.run_id = ? ORDER BY steps.id, evidence.id").all("b"))
        expect(rows).toEqual([{ status: "failed", path: "/old.txt" }, { status: "passed", path: "/new.txt" }])
      } finally {
        db.close()
      }
    })
  })

  test("a retried inherited Fix does not show the inherited log", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const run = await Effect.runPromise(historyFor("b", home, project, "2026-10-19T10:00:00.000Z"))
        await mkdir(run.runDir, { recursive: true })
        await writeFile(join(run.runDir, "fix-1.log"), "new output")
        const old = join(home, "old.log")
        await writeFile(old, "inherited output")
        await seedRun(db, "b", project, run.taskPath, "failed", run.started)
        await seedStep(db, "b", "fix", "failed", run.started, null)
        const row = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(db.query("SELECT id FROM steps WHERE run_id = ?").get("b"))
        db.query("INSERT INTO evidence (step_id, direction, path, kind) VALUES (?, ?, ?, ?)").run(row.id, "out", old, "log")
        await Effect.runPromise(recordFixStart(db, "b", 1, fixer.path, run.started))
        expect(await Effect.runPromise(readStepLog(db, "b", row.id).pipe(Effect.provide(BunServices.layer)))).toBe("new output")
      } finally {
        db.close()
      }
    })
  })

  test("a twice-skipped step does not point at a log that was never written", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const a = await Effect.runPromise(historyFor("a", home, project, "2026-10-19T09:00:00.000Z"))
        await mkdir(a.runDir, { recursive: true })
        await writeFile(join(a.runDir, "agent.log"), "original agent")
        await writeFile(join(a.runDir, "fix-1.log"), "original fix")
        await seedRun(db, "a", project, a.taskPath, "failed", a.started)
        await seedStep(db, "a", "implement", "passed", a.started, null)
        await seedStep(db, "a", "fix", "passed", a.started, null)
        const idRow = Schema.Struct({ id: Schema.Finite })
        const fix = Schema.decodeUnknownSync(idRow)(db.query("SELECT id FROM steps WHERE run_id = ? AND name = ?").get("a", "fix"))
        db.query("INSERT INTO evidence (step_id, direction, path, kind) VALUES (?, ?, ?, ?)").run(fix.id, "in", "/checks.txt", "checks")
        for (const [id, started] of [["b", "2026-10-19T10:00:00.000Z"], ["c", "2026-10-19T11:00:00.000Z"]] as const) {
          const run = await Effect.runPromise(historyFor(id, home, project, started))
          const plan = await Effect.runPromise(buildResumePlan(db, run))
          await Effect.runPromise(recordResumePublish(db, run, plan))
        }
        const steps = Schema.decodeUnknownSync(Schema.Array(idRow))(db.query("SELECT id FROM steps WHERE run_id = ? AND name IN ('implement', 'fix') ORDER BY id").all("c"))
        expect(await Promise.all(steps.map((step) => Effect.runPromise(readStepLog(db, "c", step.id).pipe(Effect.provide(BunServices.layer)))))).toEqual(["original agent", "original fix"])
      } finally {
        db.close()
      }
    })
  })

  test("a second interruption keeps the recovered implementation and its intent", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-a")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-a", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-a", "implement", "running", "2026-10-19T09:00:00.000Z", null)
        const liveId = "aaa111"
        await writeSession(join(priorDir, "session", "agent", "sessions", "enc"), "2026-10-19T09-30-00-000Z", liveId, new Date("2026-10-19T09:30:00.000Z"))
        const runB = await Effect.runPromise(historyFor("next-b", home, project, "2026-10-19T10:00:00.000Z"))
        const planB = await Effect.runPromise(buildResumePlan(db, runB))
        expect(planB.implementSessionId).toBe(liveId)
        await mkdir(runB.runDir, { recursive: true })
        await writeFile(runB.taskPath, "Do the thing.\n")
        await Effect.runPromise(recordResumePublish(db, runB, planB))
        const runC = await Effect.runPromise(historyFor("next-c", home, project, "2026-10-19T11:00:00.000Z"))
        const planC = await Effect.runPromise(buildResumePlan(db, runC))
        expect(planC.implementSessionId).toBe(liveId)
        expect(planC.skipImplement).toBe(false)
        expect(planC.implementSessionFile ?? "").toContain(liveId)
        const changed = join(home, "changed.md")
        await writeFile(changed, "Do the other thing.\n")
        expect(await taskOutcome(db, project, changed)).toContain("refuses")
      } finally {
        db.close()
      }
    })
  })

  test("a second interruption keeps the recovered fixer instead of starting fresh", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-a")
        const exportDir = join(priorDir, "sessions", "enc")
        const implementId = "aaa111"
        const fixId = "bbb222"
        const implementExport = await writeSession(exportDir, "2026-10-19T09-10-00-000Z", implementId, new Date("2026-10-19T09:10:00.000Z"))
        const liveDir = join(priorDir, "session", "agent", "sessions", "enc")
        await writeSession(liveDir, "2026-10-19T09-10-00-000Z", implementId, new Date("2026-10-19T09:10:00.000Z"))
        await writeSession(liveDir, "2026-10-19T09-40-00-000Z", fixId, new Date("2026-10-19T09:40:00.000Z"))
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await seedRun(db, "prior-a", project, join(priorDir, "task.md"), "running", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-a", "implement", "passed", "2026-10-19T09:00:00.000Z", implementExport)
        await seedStep(db, "prior-a", "fix", "running", "2026-10-19T09:35:00.000Z", null)
        const runB = await Effect.runPromise(historyFor("next-b", home, project, "2026-10-19T10:00:00.000Z"))
        const planB = await Effect.runPromise(buildResumePlan(db, runB))
        expect(planB.fixSessionId).toBe(fixId)
        await mkdir(runB.runDir, { recursive: true })
        await writeFile(runB.taskPath, "Do the thing.\n")
        await Effect.runPromise(recordResumePublish(db, runB, planB))
        const runC = await Effect.runPromise(historyFor("next-c", home, project, "2026-10-19T11:00:00.000Z"))
        const planC = await Effect.runPromise(buildResumePlan(db, runC))
        expect(planC.skipImplement).toBe(true)
        expect(planC.fixSessionId).toBe(fixId)
        expect(planC.fixSessionFile ?? "").toContain(fixId)
      } finally {
        db.close()
      }
    })
  })
})

  test("an unreadable saved task refuses rather than accepting supplied intent", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await seedRun(db, "prior-1", project, join(priorDir, "task.md"), "failed", "2026-10-19T09:00:00.000Z")
        await seedStep(db, "prior-1", "implement", "passed", "2026-10-19T09:00:00.000Z", null)
        const supplied = join(home, "supplied.md")
        await writeFile(supplied, "Do the thing.\n")
        expect(await taskOutcome(db, project, supplied)).toContain("refuses")
      } finally {
        db.close()
      }
    })
  })
})

describe("resume reads the sandbox kind from the run history", () => {
  test("a run start records its sandbox kind instead of leaving it to the next flag", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        for (const [runId, sandbox] of [["start-none", "none"], ["start-nono", "nono"]] as const) {
          const run = { ...(await Effect.runPromise(historyFor(runId, home, project, "2026-10-19T10:00:00.000Z"))), branch: "orc/" + runId, sandbox }
          await Effect.runPromise(recordResumePublish(db, run, await Effect.runPromise(buildResumePlan(db, run))))
        }
        expect([recordedSandbox(db, "start-none"), recordedSandbox(db, "start-nono")]).toEqual(["none", "nono"])
      } finally {
        db.close()
      }
    })
  })

  test("a resume without the flag after a no-sandbox start takes none instead of the nono default", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await seedSandboxRun(db, "prior-1", join(home, "repo"), "none")
        expect(await sandboxOutcome(db, join(home, "repo"), undefined)).toBe("none")
      } finally {
        db.close()
      }
    })
  })

  test("a resume without the flag after a nono start takes nono instead of running on the host", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await seedSandboxRun(db, "prior-1", join(home, "repo"), "nono")
        expect(await sandboxOutcome(db, join(home, "repo"), undefined)).toBe("nono")
      } finally {
        db.close()
      }
    })
  })

  test("a resume whose flag names the recorded kind proceeds instead of being refused", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await seedSandboxRun(db, "prior-1", join(home, "repo"), "none")
        expect(await sandboxOutcome(db, join(home, "repo"), "none")).toBe("none")
      } finally {
        db.close()
      }
    })
  })

  test("a resume flagged none after a nono start is refused instead of leaving the sandbox", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await seedSandboxRun(db, "prior-1", join(home, "repo"), "nono")
        expect(await sandboxOutcome(db, join(home, "repo"), "none")).toBe("orc: branch orc/test started with --sandbox nono, so resume refuses --sandbox none; drop --sandbox to resume with nono")
      } finally {
        db.close()
      }
    })
  })

  test("a resume flagged nono after a no-sandbox start is refused instead of entering a sandbox", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await seedSandboxRun(db, "prior-1", join(home, "repo"), "none")
        expect(await sandboxOutcome(db, join(home, "repo"), "nono")).toBe("orc: branch orc/test started with --sandbox none, so resume refuses --sandbox nono; drop --sandbox to resume with none")
      } finally {
        db.close()
      }
    })
  })

  test("a branch with no prior run takes the flag, and nono without one, instead of refusing for want of a record", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        expect([await sandboxOutcome(db, join(home, "repo"), "none"), await sandboxOutcome(db, join(home, "repo"), undefined)]).toEqual(["none", "nono"])
      } finally {
        db.close()
      }
    })
  })

  test("a run recorded with no kind takes the flag instead of refusing every flag", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await seedSandboxRun(db, "prior-1", join(home, "repo"), null)
        expect([await sandboxOutcome(db, join(home, "repo"), "none"), await sandboxOutcome(db, join(home, "repo"), undefined)]).toEqual(["none", "nono"])
      } finally {
        db.close()
      }
    })
  })
})
