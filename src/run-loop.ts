import type { AgentProvider, ExecResult, SandboxRunResult } from "@ai-hero/sandcastle"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { withHostGitSafety } from "./host"
import { buildFixPrompt, maxFixAttempts, readChecksCommands, runChecksRound, type ChecksCommand } from "./checks"
import { collectOutput, runGit } from "./git-run"
import { buildImplementPrompt, orcCompletionLine, piWithTools, sessionPrintedSignal, type PiTokenUse } from "./pi"
import { OrcRunError, describeCause, noSession, readSession } from "./run-session"
import { driveNoMistakes } from "./no-mistakes"
import type { ChecksRoundSummary, HistoryRun, OrcRunCommit, OrcRunReport, RecordedFixAttempt } from "./run-record"

export interface SandboxOps {
  readonly runAgent: (agent: AgentProvider, prompt: string, logFile: string, resumeSession?: string) => Promise<SandboxRunResult>
  readonly execCheck: (command: string) => Promise<ExecResult>
}

export interface ResumePlan {
  readonly implementSessionId: string | null
  readonly implementSessionFile: string | null
  readonly skipImplement: boolean
  readonly skipChecks: boolean
  readonly allow: boolean
}

interface AgentOutcome {
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly commits: Array<OrcRunCommit>
  readonly tokens: PiTokenUse | null
  readonly completed: boolean
  readonly markerVerified: boolean
  readonly endReason: string
}

const collectCommits = (
  run: HistoryRun,
  made: ReadonlyArray<{ readonly sha: string }>
): Effect.Effect<Array<OrcRunCommit>, OrcRunError> =>
  Effect.gen(function*() {
    const commits: Array<OrcRunCommit> = []
    for (const commit of made) {
      const subject = yield* runGit(run.spawner, run.git, ["log", "-1", "--format=%s", commit.sha], run.projectDir).pipe(
        Effect.map((logged) => logged.exitCode === 0 ? logged.stdout.trim() : ""),
        Effect.orElseSucceed(() => "")
      )
      commits.push({ sha: commit.sha, subject })
    }
    return commits
  })

interface CapturedAgentRun {
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly commits: Array<OrcRunCommit>
  readonly tokens: PiTokenUse | null
  readonly jsonl: string | null
  readonly failure: string | null
}

const sessionOf = (
  run: HistoryRun,
  storage: { readonly readHostSession: (cwd: string, id: string) => Promise<string | undefined> } | undefined,
  result: SandboxRunResult
): Effect.Effect<CapturedAgentRun, OrcRunError> =>
  Effect.gen(function*() {
    const sessionId = result.iterations.map((iteration) => iteration.sessionId).find((id) => id !== undefined) ?? null
    const sessionRead = yield* readSession(run, storage, sessionId).pipe(
      Effect.map((session) => ({ session, failure: null })),
      Effect.catchTag("OrcRunError", (error) => Effect.succeed({ session: noSession, failure: error.message }))
    )
    const commits = yield* collectCommits(run, result.commits)
    return { sessionId, sessionFile: sessionRead.session.file, commits, tokens: sessionRead.session.usage, failure: sessionRead.failure, jsonl: sessionRead.session.jsonl }
  })

const verifiedMarker = (result: SandboxRunResult, jsonl: string | null): boolean =>
  result.completionSignal === orcCompletionLine && jsonl !== null && sessionPrintedSignal(jsonl, orcCompletionLine)

const resumedCommits = (run: HistoryRun): Effect.Effect<Array<OrcRunCommit>, OrcRunError> =>
  runGit(run.spawner, run.git, ["log", run.branch, "--not", "HEAD", "--format=%H%x1f%s"], run.projectDir).pipe(
    Effect.map((logged) => {
      if (logged.exitCode !== 0) {
        return []
      }
      return logged.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
        const cut = line.indexOf("\x1f")
        return cut === -1 ? { sha: line.trim(), subject: "" } : { sha: line.slice(0, cut).trim(), subject: line.slice(cut + 1).trim() }
      })
    }),
    Effect.orElseSucceed(() => [] as Array<OrcRunCommit>)
  )

const resumedOutcome = (run: HistoryRun, sessionId: string | null, sessionFile: string | null): Effect.Effect<AgentOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const commits = yield* resumedCommits(run)
    const done = commits.length > 0
    return {
      sessionId,
      sessionFile,
      commits,
      tokens: null,
      completed: done,
      markerVerified: done,
      endReason: "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + "."
    }
  })

const implement = (run: HistoryRun, runAgent: SandboxOps["runAgent"], resumeSession: string | null): Effect.Effect<AgentOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const agentProvider = piWithTools(run.agent, {
      hostSessionsDir: run.hostSessionsDir,
      sandboxSessionsDir: run.piSessionDir
    })
    const result: SandboxRunResult = yield* Effect.tryPromise({
      try: () => runAgent(agentProvider, buildImplementPrompt(run.agent, run.path.join(run.piSessionDir, "task.md")), "agent.log", resumeSession ?? undefined),
      catch: (cause) => new OrcRunError({ message: "orc: the agent run failed: " + describeCause(cause) })
    }).pipe(withHostGitSafety(run.git))
    const session = yield* sessionOf(run, agentProvider.sessionStorage, result)
    const verified = verifiedMarker(result, session.jsonl)
    const completed = verified && session.commits.length > 0
    const endReason = session.failure ?? (!verified
      ? "Pi's final reply did not stop cleanly with " + orcCompletionLine + " on its own line."
      : (session.commits.length > 0
        ? "Pi made " + session.commits.length.toString() + (session.commits.length === 1 ? " commit" : " commits") + " on " + run.branch + "."
        : "Pi printed ORC_COMPLETE but made no commit on " + run.branch + "."))
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      commits: session.commits,
      tokens: session.tokens,
      completed,
      markerVerified: verified,
      endReason
    }
  })

const fixOnce = (
  run: HistoryRun,
  runAgent: SandboxOps["runAgent"],
  evidenceFile: string,
  attempt: number
): Effect.Effect<{ readonly fix: RecordedFixAttempt; readonly commits: ReadonlyArray<OrcRunCommit> }, OrcRunError> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    const fixerProvider = piWithTools(run.fixer, {
      hostSessionsDir: run.hostSessionsDir,
      sandboxSessionsDir: run.piSessionDir
    })
    const result: SandboxRunResult = yield* Effect.tryPromise({
      try: () => runAgent(fixerProvider, buildFixPrompt(run.fixer, evidenceFile), "fix-" + attempt + ".log"),
      catch: (cause) => new OrcRunError({ message: "orc: the fix run failed: " + describeCause(cause) })
    }).pipe(withHostGitSafety(run.git))
    const session = yield* sessionOf(run, fixerProvider.sessionStorage, result)
    const verified = verifiedMarker(result, session.jsonl)
    const ended = new Date().toISOString()
    return {
      fix: {
        attempt,
        status: verified ? "passed" : "failed",
        started,
        ended,
        agentFile: run.fixer.path,
        sessionFile: session.sessionFile,
        evidenceIn: evidenceFile,
        commits: session.commits.length,
        tokens: session.tokens
      },
      commits: session.commits
    }
  })

const installWorktreeDependencies = (run: HistoryRun): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const manifest = run.path.join(run.worktreeDir, "package.json")
    const present = yield* run.fs.exists(manifest).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot stat package.json in the Sandcastle worktree: " + String(cause) }))
    )
    if (!present) {
      return
    }
    const bun = Bun.which("bun") ?? "bun"
    const result = yield* Effect.scoped(Effect.gen(function*() {
      const handle = yield* run.spawner.spawn(ChildProcess.make(bun, ["install", "--frozen-lockfile"], { cwd: run.worktreeDir, env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" }, extendEnv: false }))
      return yield* collectOutput(handle)
    })).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: bun install in the Sandcastle worktree failed to run: " + String(cause) }))
    )
    if (result.exitCode !== 0) {
      return yield* new OrcRunError({ message: "orc: bun install in the Sandcastle worktree failed with exit " + result.exitCode.toString() + ": " + result.stderr.trim() })
    }
  })

const readProjectChecks = (run: HistoryRun): Effect.Effect<ReadonlyArray<ChecksCommand>, OrcRunError> =>
  run.fs.readFileString(run.path.join(run.worktreeDir, ".no-mistakes.yaml")).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the checks config .no-mistakes.yaml: " + String(cause) })),
    Effect.flatMap((text) =>
      readChecksCommands(text, ".no-mistakes.yaml").pipe(
        Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
      )
    )
  )

const finishAfterChecks = (run: HistoryRun, base: { readonly runId: string; readonly runDir: string; readonly branch: string; readonly agentPath: string; readonly agentSource: string; readonly model: string; readonly sessionId: string | null; readonly sessionFile: string | null; readonly tokens: PiTokenUse | null; readonly markerVerified: boolean; readonly implementPassed: boolean; readonly prLink: null; readonly noMistakes: null }, commits: Array<OrcRunCommit>, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, allow: boolean): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const noMistakes = yield* driveNoMistakes({ spawner: run.spawner, pathEnv: run.noMistakesPath, git: run.git, taskFile: run.taskPath, worktreeDir: run.worktreeDir, allow })
    return {
      ...base,
      commits,
      completed: noMistakes.status === "passed",
      checksRounds: rounds,
      fixes,
      fixAttempts: fixes.length,
      prLink: noMistakes.prLink,
      noMistakes,
      endReason: "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + ", and the checks passed. " + noMistakes.result
    }
  })

export const runFull = (run: HistoryRun, ops: SandboxOps, resume?: ResumePlan): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const plan: ResumePlan = resume ?? { implementSessionId: null, implementSessionFile: null, skipImplement: false, skipChecks: false, allow: run.allow ?? false }
    const done = plan.skipImplement
      ? yield* resumedOutcome(run, plan.implementSessionId, plan.implementSessionFile)
      : yield* implement(run, ops.runAgent, plan.implementSessionId)
    const base = {
      runId: run.runId,
      runDir: run.runDir,
      branch: run.branch,
      agentPath: run.agent.path,
      agentSource: run.agent.source,
      model: run.agent.model,
      sessionId: done.sessionId,
      sessionFile: done.sessionFile,
      tokens: done.tokens,
      markerVerified: done.markerVerified,
      implementPassed: done.completed,
      prLink: null,
      noMistakes: null
    }
    if (!done.completed) {
      return { ...base, commits: done.commits, completed: false, checksRounds: null, fixes: [], fixAttempts: 0, endReason: done.endReason }
    }
    const rounds: Array<ChecksRoundSummary> = []
    const fixes: Array<RecordedFixAttempt> = []
    const commits = [...done.commits]
    if (plan.skipChecks) {
      return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow)
    }
    for (let round = 1; round <= maxFixAttempts + 1; round += 1) {
      const started = new Date().toISOString()
      yield* installWorktreeDependencies(run)
      const commands = yield* readProjectChecks(run)
      const outcome = yield* runChecksRound(ops.execCheck, run.fs, run.path, run.piSessionDir, round, commands).pipe(
        Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
      )
      const ended = new Date().toISOString()
      const failed = outcome.outcomes.filter((check) => !check.passed).map((check) => check.name)
      rounds.push({
        round,
        file: outcome.file,
        started,
        ended,
        passed: failed.length === 0,
        failed,
        checks: outcome.outcomes.map((check) => ({ name: check.name, passed: check.passed }))
      })
      if (failed.length === 0) {
        return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow)
      }
      if (fixes.length >= maxFixAttempts) {
        return {
          ...base,
          commits,
          completed: false,
          checksRounds: rounds,
          fixes,
          fixAttempts: fixes.length,
          endReason: "The " + failed.join(", ") + " check" + (failed.length === 1 ? "" : "s") + " still failed after " + maxFixAttempts.toString() + " fix attempts; see " + outcome.file + ". No PR opens."
        }
      }
      const fixed = yield* fixOnce(run, ops.runAgent, outcome.file, fixes.length + 1)
      fixes.push(fixed.fix)
      commits.push(...fixed.commits)
    }
    return yield* new OrcRunError({ message: "orc: the checks loop ended without a result" })
  })
