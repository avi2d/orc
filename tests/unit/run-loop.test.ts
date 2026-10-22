import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../src/agents"
import { listRuns, openDatabase, recordRun, recordStep } from "../../src/run-history"
import { stepsForRun } from "../../src/history-resume"
import {
  recordChecksDone,
  recordChecksStart,
  recordFixDone,
  recordFixStart,
  recordImplementDone,
  recordImplementStart,
  recordNoMistakesDone,
  recordNoMistakesStart,
  recordResumePublish
} from "../../src/history-write"
import { buildResumePlan } from "../../src/run-resume"
import type { HistoryRun } from "../../src/run-record"
import { runFull, type RunCheckpoints, type SandboxOps } from "../../src/run-loop"

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
  const home = await mkdtemp(join(tmpdir(), "orc-loop-"))
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
  await writeFile(git, [
    "#!/bin/sh",
    "if [ \"$1\" = \"log\" ]; then",
    "  printf 'abc123\\037work\\n'",
    "fi",
    "exit 0"
  ].join("\n") + "\n")
  await chmod(git, 0o755)
  return git
}

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const historyFor = (runId: string, home: string, projectDir: string, started: string, git: string, noMistakesPath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runDir = path.join(home, "runs", runId)
    const run: HistoryRun = {
      fs, path, spawner, git, projectDir, runId, runDir,
      piSessionDir: path.join(runDir, "session"),
      hostSessionsDir: path.join(runDir, "sessions"),
      taskPath: path.join(runDir, "task.md"),
      agent: implementer, fixer, branch: "orc/test", started,
      worktreeDir: projectDir, noMistakesPath, allow: [], answers: []
    }
    return run
  }).pipe(Effect.provide(BunServices.layer))

const stubNoMistakesBin = async (dir: string): Promise<string> => {
  const bin = join(dir, "bin")
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "no-mistakes"), [
    "#!/bin/sh",
    "cat <<'EOF'",
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: completed",
    "  head: abc1234",
    "  pr: \"https://github.com/o/r/pull/7\"",
    "  findings: none",
    "outcome: passed",
    "steps[2]{step,status,findings,duration_ms}:",
    "  review,completed,0,3928",
    "  ci,completed,0,100",
    "EOF"
  ].join("\n") + "\n")
  await chmod(join(bin, "no-mistakes"), 0o755)
  return bin
}

const runLoopCheckpoints = (db: Database, run: HistoryRun): RunCheckpoints => ({
  implementStart: (started) => recordImplementStart(db, run, started),
  implementDone: (outcome, started, ended) =>
    recordImplementDone(db, run, {
      agentPath: run.agent.path,
      sessionFile: outcome.sessionFile,
      tokens: outcome.tokens,
      commits: outcome.commits,
      implementPassed: outcome.completed
    }, started, ended),
  checksRoundStart: (round, started) => recordChecksStart(db, run.runId, round, started),
  checksRoundDone: (round) => recordChecksDone(db, run.runId, round),
  fixStart: (attempt, started) => recordFixStart(db, run.runId, attempt, run.fixer.path, started),
  fixDone: (fix) => recordFixDone(db, run.runId, fix),
  noMistakesStart: (started) => recordNoMistakesStart(db, run.runId, started),
  noMistakesDone: (record) => recordNoMistakesDone(db, run, record)
})

const seedRefusedPrior = async (db: Database, priorDir: string, project: string): Promise<void> => {
  await mkdir(join(priorDir, "sessions", "enc"), { recursive: true })
  const implementSession = join(priorDir, "sessions", "enc", "2026-10-19T09-10-00-000Z_aaa111.jsonl")
  await writeFile(implementSession, JSON.stringify({ type: "session", id: "aaa111" }) + "\n")
  const fixSession = join(priorDir, "sessions", "enc", "2026-10-19T09-30-00-000Z_bbb222.jsonl")
  await writeFile(fixSession, JSON.stringify({ type: "session", id: "bbb222" }) + "\n")
  await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
  await writeFile(join(priorDir, "checks-1.md"), "checks\n")
  await Effect.runPromise(recordRun(db, {
    id: "prior-a", project, branch: "orc/test", taskFile: join(priorDir, "task.md"),
    status: "failed", started: "2026-10-19T09:00:00.000Z"
  }).pipe(Effect.asVoid))
  await Effect.runPromise(recordStep(db, {
    runId: "prior-a", name: "implement", attempt: 1, status: "passed",
    started: "2026-10-19T09:00:00.000Z", agentFile: implementer.path, piSessionFile: implementSession
  }).pipe(Effect.asVoid))
  await Effect.runPromise(recordChecksDone(db, "prior-a", {
    round: 1, file: join(priorDir, "checks-1.md"),
    started: "2026-10-19T09:20:00.000Z", ended: "2026-10-19T09:21:00.000Z",
    passed: true, failed: [], checks: [{ name: "lint", passed: true }]
  }))
  await Effect.runPromise(recordFixDone(db, "prior-a", {
    attempt: 1, status: "passed",
    started: "2026-10-19T09:22:00.000Z", ended: "2026-10-19T09:23:00.000Z",
    agentFile: fixer.path, sessionFile: fixSession, evidenceIn: join(priorDir, "checks-1.md"),
    commits: 1, tokens: { input: 10, output: 5 }
  }))
  await Effect.runPromise(recordStep(db, {
    runId: "prior-a", name: "no-mistakes", attempt: 1, status: "failed",
    started: "2026-10-19T09:24:00.000Z", agentFile: null, piSessionFile: null
  }).pipe(Effect.asVoid))
}

describe("resumed runs publish inherited progress atomically", () => {
  test("the new attempt records its run row and every inherited step together", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        await seedRefusedPrior(db, join(home, "runs", "prior-a"), project)
        const run = await Effect.runPromise(historyFor("next-b", home, project, "2026-10-19T10:00:00.000Z", git, ""))
          const plan = await Effect.runPromise(buildResumePlan(db, run))
          expect(plan.skipImplement).toBe(true)
          expect(plan.skipChecks).toBe(true)
          expect(plan.inheritedRounds.length).toBe(1)
          expect(plan.inheritedFixes.length).toBe(1)
          await Effect.runPromise(recordResumePublish(db, run, plan))
          const runs = await Effect.runPromise(listRuns(db))
          expect(runs.find((known) => known.id === "next-b")?.status).toBe("running")
          const steps = await Effect.runPromise(stepsForRun(db, "next-b"))
          expect(steps.find((step) => step.name === "implement")).toMatchObject({ status: "passed", piSessionFile: plan.implementSessionFile })
          expect(steps.find((step) => step.name === "checks")).toMatchObject({ status: "passed" })
          expect(steps.find((step) => step.name === "fix")).toMatchObject({ status: "passed" })
          expect(steps.some((step) => step.status === "running")).toBe(false)
        } finally {
          db.close()
        }
    })
  })

  test("a resumed run never marks skipped work running", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        await seedRefusedPrior(db, join(home, "runs", "prior-a"), project)
        const bin = await stubNoMistakesBin(home)
        const run = await Effect.runPromise(historyFor(
          "next-b", home, project, "2026-10-19T10:00:00.000Z", git,
          bin + ":" + (process.env.PATH ?? "")
        ))
          await mkdir(run.runDir, { recursive: true })
          await writeFile(join(run.runDir, "task.md"), "Do the thing.\n")
          const plan = await Effect.runPromise(buildResumePlan(db, run))
          await Effect.runPromise(recordResumePublish(db, run, plan))
          const calls = { implementStart: 0, implementDone: 0, agent: 0, checks: 0 }
          const ops: SandboxOps = {
            runAgent: async () => {
              calls.agent += 1
              throw new Error("the agent ran despite skipped work")
            },
            execCheck: async () => {
              calls.checks += 1
              return { stdout: "", stderr: "", exitCode: 0 }
            }
          }
          const real = runLoopCheckpoints(db, run)
          const checkpoints: RunCheckpoints = {
            ...real,
            implementStart: (started) =>
              Effect.tap(real.implementStart(started), () => Effect.sync(() => { calls.implementStart += 1 })),
            implementDone: (outcome, started, ended) =>
              Effect.tap(real.implementDone(outcome, started, ended), () => Effect.sync(() => { calls.implementDone += 1 }))
          }
          const report = await Effect.runPromise(runFull(run, ops, plan, checkpoints))
          expect(calls.implementStart).toBe(0)
          expect(calls.implementDone).toBe(0)
          expect(calls.agent).toBe(0)
          expect(calls.checks).toBe(0)
          expect(report.completed).toBe(true)
          expect(report.checksRounds?.length).toBe(1)
          expect(report.fixes.length).toBe(1)
        } finally {
          db.close()
        }
    })
  })
})

describe("runFull has no checkpoint-free mode", () => {
  test("omitted checkpoints fail before agent or check work runs", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        const run = await Effect.runPromise(historyFor("next-x", home, project, "2026-10-19T10:00:00.000Z", git, ""))
        const plan = { implementSessionId: null, implementSessionFile: null, skipImplement: false, skipChecks: false, allow: [], answers: [], inheritedRounds: [], inheritedFixes: [], fixSessionId: null, fixSessionFile: null, fixRunning: false }
        let agentCalls = 0
        let checkCalls = 0
        const ops: SandboxOps = {
          runAgent: async () => {
            agentCalls += 1
            throw new Error("checkpoint-free agent work")
          },
          execCheck: async () => {
            checkCalls += 1
            return { stdout: "", stderr: "", exitCode: 0 }
          }
        }
        const exit = await Effect.runPromiseExit(Reflect.apply(runFull, null, [run, ops, plan]))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(agentCalls).toBe(0)
        expect(checkCalls).toBe(0)
        let checkpointedAgentCalls = 0
        const failingOps: SandboxOps = {
          runAgent: async () => {
            checkpointedAgentCalls += 1
            throw new Error("checkpointed agent work")
          },
          execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        }
        const checkpoints = runLoopCheckpoints(db, run)
        const checkpointedExit = await Effect.runPromiseExit(runFull(run, failingOps, plan, checkpoints))
        expect(Exit.isFailure(checkpointedExit)).toBe(true)
        expect(checkpointedAgentCalls).toBe(1)
        const steps = await Effect.runPromise(stepsForRun(db, "next-x"))
        expect(steps.some((step) => step.name === "implement")).toBe(true)
      } finally {
        db.close()
      }
    })
  })
})
