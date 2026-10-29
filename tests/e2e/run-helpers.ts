import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/agents"
import { subprocessNoMistakesRunner, type QuestionAnswer } from "../../packages/run/src/no-mistakes"
import { hostGitShim } from "../../packages/run/src/host"
import { orcCompletionLine } from "../../packages/run/src/pi"
import { runWithHistory, type SandboxOps } from "../../packages/run/src/run"
import type { OrcRunReport } from "../../packages/run/src/run-record"
import { listRuns, openDatabase, type RunRecord } from "../../packages/run/src/run-history"

export const git = (dir: string, args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" "))
  }
  return result.stdout.toString().trim()
}

export const withRepo = async (use: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-run-unit-"))
  try {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.name", "orc test"])
    git(dir, ["config", "user.email", "orc@test.invalid"])
    await writeFile(join(dir, "seed.txt"), "seed\n")
    git(dir, ["add", "seed.txt"])
    git(dir, ["commit", "-qm", "seed"])
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-run-home-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const implementer: AgentFile = {
  kind: "implementer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read", "bash"],
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
}

const sessionId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const prompt = "Read the task. When the work is committed on this branch, print " + orcCompletionLine + " on its own line and stop."

const entry = (message: Record<string, unknown>): string => JSON.stringify({ type: "message", message })

export const sessionEnding = (final: Record<string, unknown>): string =>
  [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-19T10:00:00.000Z", cwd: "/sandbox/repo" }),
    entry({ role: "user", content: [{ type: "text", text: prompt }] }),
    entry({
      role: "assistant",
      content: [{ type: "text", text: "Plan, then print\n" + orcCompletionLine }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git commit -am work" } }],
      stopReason: "toolUse",
      usage: { input: 100, output: 20 }
    }),
    entry({ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "[orc/test 1a2b3c4] work" }], isError: false }),
    entry(final)
  ].join("\n") + "\n"

export const providerErrorEchoingPrompt = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 invalid request: " + prompt, usage: { input: 0, output: 0 } }

export const cleanFinish = { role: "assistant", content: [{ type: "text", text: "Committed.\n" + orcCompletionLine }], stopReason: "stop", rawStopReason: "completed", usage: { input: 50, output: 5 } }

export const commitOnBranch = async (dir: string, branch: string): Promise<string> => {
  git(dir, ["checkout", "-q", "-b", branch])
  await writeFile(join(dir, "work.txt"), "work\n")
  git(dir, ["add", "work.txt"])
  git(dir, ["commit", "-qm", "work"])
  const sha = git(dir, ["rev-parse", "HEAD"])
  git(dir, ["checkout", "-q", "-"])
  return sha
}

export interface StepOutcome {
  readonly report: OrcRunReport
  readonly run: RunRecord | undefined
  readonly steps: unknown
  readonly signals: unknown
  readonly evidence: string
}

const unexpectedChecks: SandboxOps["execCheck"] = async () => {
  throw new Error("checks ran before implement completed")
}

export interface NoMistakesReply {
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number
}

export const passedWithPr: NoMistakesReply = {
  stdout: [
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: completed",
    "  head: abc1234",
    "  pr: \"https://github.com/o/r/pull/7\"",
    "  findings: none",
    "outcome: passed"
  ].join("\n") + "\n"
}

export const checksPassedWhileMonitoring: NoMistakesReply = {
  stdout: [
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: running",
    "  head: abc1234",
    "  pr: \"https://github.com/o/r/pull/7\"",
    "outcome: checks-passed"
  ].join("\n") + "\n"
}

export const recordedNothing: NoMistakesReply = {
  stdout: [
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: running",
    "  pr: \"https://github.com/o/r/pull/7\"",
    "  steps[2]{step,status,findings,duration_ms}:",
    "    review,completed,0,3928",
    "    ci,running,0,0"
  ].join("\n") + "\n"
}

const stubNoMistakes = async (replies: ReadonlyArray<NoMistakesReply>): Promise<{ readonly dir: string; readonly calls: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-nm-stub-"))
  const repliesDir = join(dir, "replies")
  await mkdir(repliesDir)
  for (const [index, reply] of replies.entries()) {
    await writeFile(join(repliesDir, (index + 1).toString()), reply.stdout)
    if (reply.exitCode !== undefined && reply.exitCode !== 0) {
      await writeFile(join(repliesDir, (index + 1).toString() + ".exit"), reply.exitCode.toString())
    }
    if (reply.stderr !== undefined) {
      await writeFile(join(repliesDir, (index + 1).toString() + ".err"), reply.stderr)
    }
  }
  const calls = join(dir, "calls")
  const count = join(dir, "count")
  await writeFile(calls, "")
  await writeFile(count, "1")
  const script = ["#!/bin/sh", "echo \"$@\" >> \"" + calls + "\"", "pwd >> \"" + calls + "\"",
    "git status --porcelain > /dev/null 2>&1",
    "n=$(cat \"" + count + "\")", "echo $((n + 1)) > \"" + count + "\"",
    "if [ ! -f \"" + repliesDir + "\"/\"$n\" ]; then echo 'unexpected no-mistakes call' >&2; exit 1; fi",
    "cat \"" + repliesDir + "\"/\"$n\"",
    "code=$(cat \"" + repliesDir + "\"/\"$n\".exit 2>/dev/null || echo 0)",
    "err=\"" + repliesDir + "\"/\"$n\".err", "if [ -f \"$err\" ]; then cat \"$err\" >&2; fi",
    "exit \"$code\""].join("\n") + "\n"
  await writeFile(join(dir, "no-mistakes"), script)
  await chmod(join(dir, "no-mistakes"), 0o755)
  return { dir, calls }
}

const unexpectedNoMistakes: ReadonlyArray<NoMistakesReply> = [{ stdout: "", stderr: "unexpected no-mistakes call", exitCode: 1 }]
export const runStep = (dir: string, home: string, sandbox: SandboxOps["runAgent"], execCheck: SandboxOps["execCheck"] = unexpectedChecks, nmReplies: ReadonlyArray<NoMistakesReply> = unexpectedNoMistakes, answers: ReadonlyArray<QuestionAnswer> = []): Promise<StepOutcome & { readonly nmCalls: string }> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const runDir = path.join(home, "runs", "step-run-1")
      yield* fs.makeDirectory(path.join(runDir, "sessions"), { recursive: true })
      const stub = yield* Effect.promise(() => stubNoMistakes(nmReplies))
      yield* fs.writeFileString(path.join(runDir, "task.md"), "Do the thing.\n")
      const hostGit = yield* hostGitShim(fs, path, Bun.which("git") ?? "git")
      return yield* Effect.acquireUseRelease(
        openDatabase(home),
        (db) =>
          Effect.gen(function*() {
            const report = yield* runWithHistory(db, {
              fs, path, spawner, git: hostGit, projectDir: dir, runId: "step-run-1", runDir,
              piSessionDir: path.join(runDir, "session"), hostSessionsDir: path.join(runDir, "sessions"),
              taskPath: path.join(runDir, "task.md"), agent: implementer, fixer, branch: "orc/test", sandbox: "nono", started: "2026-10-19T10:00:00.000Z",
              worktreeDir: dir,
              noMistakes: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: stub.dir + ":" + (process.env.PATH ?? ""), git: hostGit, worktreeDir: dir }),
              answers
            }, { runAgent: sandbox, execCheck })
            const runs = yield* listRuns(db)
            const steps = db.query("SELECT name, status FROM steps WHERE run_id = ?").all("step-run-1")
            const signals = db.query("SELECT name, value FROM signals ORDER BY name").all()
            const evidence = yield* fs.readFileString(path.join(runDir, "implement-1.md"))
            const nmCalls = yield* fs.readFileString(stub.calls)
            return { report, run: runs.find((run) => run.id === "step-run-1"), steps, signals, evidence, nmCalls }
          }),
        (db) => Effect.sync(() => db.close())
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

const fixer: AgentFile = {
  kind: "fixer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read", "bash"],
  body: "Fix the failure.",
  path: "bundled/fixer.md",
  source: "bundled"
}

export const capturedSession = (home: string, jsonl: string): Promise<void> => {
  const dir = join(home, "runs", "step-run-1", "sessions", "--sandbox-repo--")
  return mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, "2026-10-19T10-00-00-000Z_" + sessionId + ".jsonl"), jsonl))
}

export const sandboxResult = (sha: string, final: Record<string, unknown>): SandboxOps["runAgent"] => async () => ({
  iterations: [{ sessionId }],
  completionSignal: orcCompletionLine,
  stdout: JSON.stringify({ type: "message_end", message: final }),
  commits: [{ sha }]
})

export const readyToCheck = async (dir: string, home: string): Promise<string> => {
  const sha = await commitOnBranch(dir, "orc/test")
  await capturedSession(home, sessionEnding(cleanFinish))
  await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
  return sha
}
