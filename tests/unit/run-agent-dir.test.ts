import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { askSetupFor } from "../../packages/run/src/entities/agent/index"
import { openDatabase, reportFileName } from "../../packages/run/src/entities/run-history/index"
import { subprocessNoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { QuestionAnswer } from "../../packages/run/src/entities/review-gate/index"
import { runWithHistory } from "../../packages/run/src/features/running-a-task/run"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"
import { fakeOps } from "../lib/fake-ops"

const agentFile = (kind: "implementer" | "fixer"): AgentFile => ({
  kind,
  model: "example/sample",
  thinking: "high",
  tools: ["read"],
  body: "Do the task.",
  path: "bundled/" + kind + ".md",
  source: "bundled"
})

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-agent-dir-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const stubGit = async (dir: string): Promise<string> => {
  const bin = join(dir, "git-bin")
  await mkdir(bin, { recursive: true })
  const git = join(bin, "git")
  await writeFile(git, "#!/bin/sh\nexit 0\n")
  await chmod(git, 0o755)
  return git
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const preparedRun = async (home: string, runId: string, started: string, extra: { readonly resumeRun?: string; readonly answers?: ReadonlyArray<QuestionAnswer> } = {}): Promise<HistoryRun> => {
  const project = join(home, "project")
  await mkdir(project, { recursive: true })
  const git = await stubGit(home)
  const run = await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runDir = path.join(home, "runs", runId)
    const answers = extra.answers ?? []
    const value: HistoryRun = {
      fs, path, spawner, git, projectDir: project, runId, runDir,
      piSessionDir: path.join(runDir, "session"),
      hostSessionsDir: path.join(runDir, "sessions"),
      taskPath: path.join(runDir, "task.md"),
      instructions: null,
      agent: agentFile("implementer"), fixer: agentFile("fixer"), branch: "orc/sample", sandbox: "none", started,
      asks: askSetupFor(runDir, path.join(runDir, "session"), 600, answers, []),
      worktreeDir: project,
      machine: null,
      delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git, worktreeDir: project }) },
      allow: [], answers, resumeRun: extra.resumeRun
    }
    return value
  }).pipe(Effect.provide(BunServices.layer)))
  await mkdir(join(run.piSessionDir, "agent"), { recursive: true })
  await writeFile(join(run.piSessionDir, "agent", "models.json"), "{}\n")
  await writeFile(join(run.piSessionDir, "agent", "settings.json"), "{}\n")
  await writeFile(join(run.piSessionDir, "task.md"), "Add a sample widget.\n")
  await writeFile(run.taskPath, "Add a sample widget.\n")
  await writeFile(join(run.runDir, "agent.log"), "pi output\n")
  await writeFile(join(run.runDir, "prepare.log"), "install output\n")
  await mkdir(run.hostSessionsDir, { recursive: true })
  return run
}

const writeSession = async (run: HistoryRun, id: string): Promise<string> => {
  const file = join(run.hostSessionsDir, "2026-11-24T09-00-00-000Z_" + id + ".jsonl")
  await writeFile(file, JSON.stringify({ type: "session", id, timestamp: "2026-11-24T09:00:00.000Z", cwd: run.worktreeDir }) + "\n")
  return file
}

describe("the Pi agent folder after a run ends", () => {
  test("a failed run drops session/agent without deleting the report, the task, the logs or the sessions with it", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const run = await preparedRun(home, "run-1", "2026-11-24T09:00:00.000Z")
        const session = await writeSession(run, "done-1")
        const report = await Effect.runPromise(runWithHistory(db, run, fakeOps({
          runAgent: async () => ({ sessionId: "done-1", commits: [] }),
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }, run.hostSessionsDir)))
        expect(report.completed).toBe(false)
        expect(await exists(join(run.piSessionDir, "agent"))).toBe(false)
        expect(await exists(join(run.runDir, reportFileName))).toBe(true)
        expect(await exists(run.taskPath)).toBe(true)
        expect(await exists(join(run.piSessionDir, "task.md"))).toBe(true)
        expect(await exists(join(run.runDir, "agent.log"))).toBe(true)
        expect(await exists(join(run.runDir, "prepare.log"))).toBe(true)
        expect(await exists(session)).toBe(true)
      } finally {
        db.close()
      }
    })
  })

  test("a successful run drops the agent folder without deleting the report, task, logs or sessions", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const run = await preparedRun(home, "run-success", "2026-11-24T09:00:00.000Z")
        await writeFile(join(run.projectDir, ".no-mistakes.yaml"), "commands:\n  test: bun test\n")
        const session = await writeSession(run, "success-1")
        await writeFile(session, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ORC_COMPLETE" }] } }) + "\n")
        const runner = {
          init: Effect.die("unexpected init"),
          start: () => Effect.succeed({ stdout: "outcome: passed\npr: https://example.com/pr/1\n", stderr: "", exitCode: 0 }),
          reattach: Effect.die("unexpected reattach"),
          respond: () => Effect.die("unexpected gate"),
          answer: () => Effect.die("unexpected question"),
          status: () => Effect.die("unexpected status"),
          logs: () => Effect.die("unexpected logs")
        }
        const report = await Effect.runPromise(runWithHistory(db, { ...run, delivery: { kind: "no-mistakes", runner } }, fakeOps({
          runAgent: async () => ({ sessionId: "success-1", commits: [{ sha: "abc1234" }] }),
          execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        }, run.hostSessionsDir)))
        expect(report.completed).toBe(true)
        expect(await exists(join(run.piSessionDir, "agent"))).toBe(false)
        expect(await exists(join(run.runDir, reportFileName))).toBe(true)
        expect(await exists(run.taskPath)).toBe(true)
        expect(await exists(join(run.runDir, "agent.log"))).toBe(true)
        expect(await exists(join(run.runDir, "prepare.log"))).toBe(true)
        expect(await exists(session)).toBe(true)
      } finally {
        db.close()
      }
    })
  })

  test("a parked run keeps session/agent instead of dropping it, and the next run resumes its session", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const parked = await preparedRun(home, "run-1", "2026-11-24T09:00:00.000Z")
        await writeSession(parked, "parked-1")
        const parkedReport = await Effect.runPromise(runWithHistory(db, parked, fakeOps({
          runAgent: async () => ({
            sessionId: "parked-1",
            commits: [],
            end: { kind: "asked", question: { id: "Q1", text: "Which colour should the widget use?", asked: "2026-11-24T09:05:00.000Z", blocks: true } }
          }),
          execCheck: async () => { throw new Error("checks must not run while the worker waits on an answer") }
        }, parked.hostSessionsDir)))
        expect(parkedReport.completed).toBe(false)
        expect(await exists(join(parked.piSessionDir, "agent", "models.json"))).toBe(true)
        const next = await preparedRun(home, "run-2", "2026-11-24T10:00:00.000Z", { resumeRun: "run-1", answers: [{ question: "Q1", answer: "Blue" }] })
        const resumed: Array<string | null> = []
        await Effect.runPromise(runWithHistory(db, next, fakeOps({
          runAgent: async ({ resumeSession }) => {
            resumed.push(resumeSession)
            return { commits: [] }
          },
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }, next.hostSessionsDir)))
        expect(resumed).toEqual([join(next.hostSessionsDir, "2026-11-24T09-00-00-000Z_parked-1.jsonl")])
      } finally {
        db.close()
      }
    })
  })
})
