import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { askSetupFor } from "../../packages/run/src/entities/agent/index"
import { openDatabase, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"
import {
  recordChecksDone,
  recordChecksStart,
  recordFixDone,
  recordFixStart,
  recordImplementDone,
  recordImplementStart,
  recordOpenQuestion,
  recordNoMistakesDone,
  recordNoMistakesStart,
  recordPullRequestDone,
  recordPullRequestStart,
  recordStepSession
} from "../../packages/run/src/features/running-a-task/history-write"
import { subprocessNoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"
import type { RunCheckpoints } from "../../packages/run/src/features/running-a-task/run-ops"

export const implementer: AgentFile = {
  kind: "implementer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read"],
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
}

export const fixer: AgentFile = {
  kind: "fixer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read"],
  body: "Fix the failure.",
  path: "bundled/fixer.md",
  source: "bundled"
}

export const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-loop-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

export const stubGit = async (dir: string): Promise<string> => {
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

export const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

export const historyFor = (runId: string, home: string, projectDir: string, started: string, git: string, noMistakesPath: string): Effect.Effect<HistoryRun> =>
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
      instructions: null,
      agent: implementer, fixer, branch: "orc/test", sandbox: "nono", started,
      asks: askSetupFor(runDir, path.join(runDir, "session"), 600, [], []),
      worktreeDir: projectDir,
      machine: null,
      delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: noMistakesPath, git, worktreeDir: projectDir }) },
      allow: [], answers: []
    }
    return run
  }).pipe(Effect.provide(BunServices.layer))

export const stubNoMistakesBin = async (dir: string): Promise<string> => {
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

export const runLoopCheckpoints = (db: Database, run: HistoryRun): RunCheckpoints => ({
  implementStart: (started) => recordImplementStart(db, run, started),
  implementSession: (file) => recordStepSession(db, run.runId, "implement", 1, file),
  implementDone: (outcome, started, ended) =>
    recordImplementDone(db, run, {
      agentPath: run.agent.path,
      sessionFile: outcome.sessionFile,
      tokens: outcome.tokens,
      commits: outcome.commits,
      sessionSize: outcome.sessionSize,
      implementPassed: outcome.completed
    }, started, ended),
  checksRoundStart: (round, started) => recordChecksStart(db, run.runId, round, started),
  checksRoundDone: (round) => recordChecksDone(db, run.runId, round),
  fixStart: (attempt, started) => recordFixStart(db, run.runId, attempt, run.fixer, started),
  fixSession: (attempt, file) => recordStepSession(db, run.runId, "fix", attempt, file),
  fixDone: (fix) => recordFixDone(db, run.runId, fix),
  noMistakesStart: (started) => recordNoMistakesStart(db, run.runId, started),
  noMistakesDone: (record) => recordNoMistakesDone(db, run, record),
  pullRequestStart: (started) => recordPullRequestStart(db, run.runId, started),
  pullRequestDone: (record) => recordPullRequestDone(db, run, record),
  questionAsked: (step, question) => recordOpenQuestion(db, run.runId, step, question)
})

export const seedRefusedPrior = async (db: Database, priorDir: string, project: string): Promise<void> => {
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
    started: "2026-10-19T09:00:00.000Z", agentFile: implementer.path, piSessionFile: implementSession, model: implementer.model, thinking: implementer.thinking
  }).pipe(Effect.asVoid))
  await Effect.runPromise(recordChecksDone(db, "prior-a", {
    round: 1, file: join(priorDir, "checks-1.md"),
    started: "2026-10-19T09:20:00.000Z", ended: "2026-10-19T09:21:00.000Z",
    passed: true, failed: [], checks: [{ name: "lint", passed: true }], refusals: []
  }))
  await Effect.runPromise(recordFixDone(db, "prior-a", {
    attempt: 1, status: "passed",
    started: "2026-10-19T09:22:00.000Z", ended: "2026-10-19T09:23:00.000Z",
    agentFile: fixer.path, sessionFile: fixSession, model: fixer.model, thinking: fixer.thinking, evidenceIn: join(priorDir, "checks-1.md"),
    commits: 1, tokens: { input: 10, output: 5 }
  }))
  await Effect.runPromise(recordStep(db, {
    runId: "prior-a", name: "no-mistakes", attempt: 1, status: "failed",
    started: "2026-10-19T09:24:00.000Z", agentFile: null, piSessionFile: null
  }).pipe(Effect.asVoid))
}
