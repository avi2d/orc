import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/agents"
import { openDatabase, recordRun, recordStep } from "../../packages/run/src/run-history"
import { buildResumePlan, resolveTaskFile } from "../../packages/run/src/run-resume"
import { recordResumePublish } from "../../packages/run/src/history-write"
import { subprocessNoMistakesRunner } from "../../packages/run/src/no-mistakes"
import { noSandboxEnv } from "../../packages/run/src/no-sandbox"
import type { HistoryRun } from "../../packages/run/src/run-record"

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
      agent: implementer, fixer, branch: "orc/test", started,
      worktreeDir: projectDir,
      noMistakes: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git: "git", worktreeDir: projectDir }),
      allow: [], answers: []
    }
    return run
  }).pipe(Effect.provide(BunServices.layer))

const seedRun = (db: Database, id: string, project: string, taskFile: string, status: "running" | "failed", started: string): Promise<void> =>
  Effect.runPromise(recordRun(db, { id, project, branch: "orc/test", taskFile, status, started }).pipe(Effect.asVoid))

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
        expect(plan.implementSessionFile ?? "").toContain(join("sessions", "host"))
        expect(plan.implementSessionFile ?? "").toContain(liveId)
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
        expect(plan.fixSessionFile ?? "").toContain(join("sessions", "host"))
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
        expect(JSON.parse(carried.split("\n")[0]).cwd).toBe(worktree)
      } finally {
        db.close()
      }
    })
  })

  test("an interrupted no-sandbox implementation resumes the session Pi wrote under sessions instead of starting fresh", async () => {
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
        const sessionDir = noSandboxEnv({ piSessionDir: join(priorDir, "session"), hostSessionsDir: join(priorDir, "sessions") }).PI_CODING_AGENT_SESSION_DIR
        await writeSession(sessionDir, "2026-10-19T09-30-00-000Z", liveId, new Date("2026-10-19T09:30:00.000Z"))
        const run = await Effect.runPromise(historyFor("next-1", home, project, "2026-10-19T10:00:00.000Z"))
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.implementSessionId).toBe(liveId)
        expect(plan.skipImplement).toBe(false)
        const nextSessions = noSandboxEnv({ piSessionDir: join(home, "runs", "next-1", "session"), hostSessionsDir: join(home, "runs", "next-1", "sessions") }).PI_CODING_AGENT_SESSION_DIR
        expect(dirname(plan.implementSessionFile ?? "")).toBe(nextSessions)
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
