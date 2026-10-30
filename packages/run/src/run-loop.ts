import type { AgentProvider, ExecResult, SandboxRunResult } from "@ai-hero/sandcastle"
import { Effect } from "effect"
import { withHostGitSafety } from "./host"
import { buildFixPrompt, maxFixAttempts, readChecksCommands, runChecksRound, type ChecksCommand } from "./checks"
import { branchCommits, runGit } from "./git-run"
import { buildImplementPrompt, finalReplyError, orcCompletionLine, piWithTools, sessionPrintedSignal, type PiTokenUse } from "./pi"
import { OrcRunError, describeCause, noSession, readSession } from "./run-session"
import { driveNoMistakes, type AllowWord, type QuestionAnswer } from "./no-mistakes"
import { countSessionSize, handoverImplementPrompt, type LongSessionCounts } from "./long-session"
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
  readonly allow: ReadonlyArray<AllowWord>
  readonly answers: ReadonlyArray<QuestionAnswer>
  readonly inheritedRounds: ReadonlyArray<ChecksRoundSummary>
  readonly inheritedFixes: ReadonlyArray<RecordedFixAttempt>
  readonly fixSessionId: string | null
  readonly fixSessionFile: string | null
  readonly fixRunning: boolean
  readonly handover: string | null
}

interface AgentOutcome {
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly commits: Array<OrcRunCommit>
  readonly tokens: PiTokenUse | null
  readonly sessionSize: LongSessionCounts | null
  readonly completed: boolean
  readonly markerVerified: boolean
  readonly endReason: string
}

export interface RunCheckpoints {
  readonly implementStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly implementDone: (outcome: AgentOutcome, started: string, ended: string) => Effect.Effect<void, OrcRunError>
  readonly checksRoundStart: (round: number, started: string) => Effect.Effect<void, OrcRunError>
  readonly checksRoundDone: (round: ChecksRoundSummary) => Effect.Effect<void, OrcRunError>
  readonly fixStart: (attempt: number, started: string) => Effect.Effect<void, OrcRunError>
  readonly fixDone: (fix: RecordedFixAttempt) => Effect.Effect<void, OrcRunError>
  readonly noMistakesStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly noMistakesDone: (record: import("./no-mistakes").NoMistakesRecord) => Effect.Effect<void, OrcRunError>
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
  readonly sessionSize: LongSessionCounts | null
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
    const sessionSize = sessionRead.session.jsonl === null ? null : countSessionSize(sessionRead.session.jsonl)
    return { sessionId, sessionFile: sessionRead.session.file, commits, tokens: sessionRead.session.usage, failure: sessionRead.failure, jsonl: sessionRead.session.jsonl, sessionSize }
  })

const verifiedMarker = (result: SandboxRunResult, jsonl: string | null): boolean =>
  result.completionSignal === orcCompletionLine && jsonl !== null && sessionPrintedSignal(jsonl, orcCompletionLine)

const resumedCommits = (run: HistoryRun): Effect.Effect<Array<OrcRunCommit>, OrcRunError> =>
  branchCommits(run.spawner, run.git, run.branch, run.projectDir)

const resumedOutcome = (run: HistoryRun, sessionId: string | null, sessionFile: string | null): Effect.Effect<AgentOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const commits = yield* resumedCommits(run)
    const done = commits.length > 0
    return {
      sessionId,
      sessionFile,
      commits,
      tokens: null,
      sessionSize: null,
      completed: done,
      markerVerified: done,
      endReason: "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + "."
    }
  })

const implementPrompt = (run: HistoryRun, plan: Pick<ResumePlan, "handover">): string => {
  const taskFile = run.path.join(run.piSessionDir, "task.md")
  return plan.handover === null ? buildImplementPrompt(run.agent, taskFile) : handoverImplementPrompt(run.agent, taskFile, plan.handover)
}

const replyErrorNote = (jsonl: string | null): string => {
  const error = jsonl === null ? null : finalReplyError(jsonl)
  return error === null ? "" : " It ended in an error: " + error
}

const implement = (run: HistoryRun, runAgent: SandboxOps["runAgent"], plan: Pick<ResumePlan, "implementSessionId" | "handover">): Effect.Effect<AgentOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const agentProvider = piWithTools(run.agent, {
      hostSessionsDir: run.hostSessionsDir,
      sandboxSessionsDir: run.path.join(run.piSessionDir, "agent", "sessions")
    })
    const result: SandboxRunResult = yield* Effect.tryPromise({
      try: () => runAgent(agentProvider, implementPrompt(run, plan), "agent.log", plan.implementSessionId ?? undefined),
      catch: (cause) => new OrcRunError({ message: "orc: the agent run failed: " + describeCause(cause) })
    }).pipe(withHostGitSafety(run.git))
    const session = yield* sessionOf(run, agentProvider.sessionStorage, result)
    const verified = verifiedMarker(result, session.jsonl)
    const prior = plan.implementSessionId === null && plan.handover === null ? [] : yield* resumedCommits(run)
    const seen = new Set(session.commits.map((commit) => commit.sha))
    const commits = [...session.commits, ...prior.filter((commit) => !seen.has(commit.sha))]
    const completed = verified && commits.length > 0
    const endReason = session.failure ?? (!verified
      ? "Pi's final reply did not stop cleanly with " + orcCompletionLine + " on its own line." + replyErrorNote(session.jsonl)
      : (commits.length > 0
        ? "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + "."
        : "Pi printed ORC_COMPLETE but made no commit on " + run.branch + "."))
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      commits,
      tokens: session.tokens,
      sessionSize: session.sessionSize,
      completed,
      markerVerified: verified,
      endReason
    }
  })

const fixOnce = (
  run: HistoryRun,
  runAgent: SandboxOps["runAgent"],
  evidenceFile: string,
  attempt: number,
  resumeSession: string | null
): Effect.Effect<{ readonly fix: RecordedFixAttempt; readonly commits: ReadonlyArray<OrcRunCommit> }, OrcRunError> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    const fixerProvider = piWithTools(run.fixer, {
      hostSessionsDir: run.hostSessionsDir,
      sandboxSessionsDir: run.path.join(run.piSessionDir, "agent", "sessions")
    })
    const result: SandboxRunResult = yield* Effect.tryPromise({
      try: () => runAgent(fixerProvider, buildFixPrompt(run.fixer, evidenceFile), "fix-" + attempt + ".log", resumeSession ?? undefined),
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

const readProjectChecks = (run: HistoryRun): Effect.Effect<ReadonlyArray<ChecksCommand>, OrcRunError> =>
  run.fs.readFileString(run.path.join(run.worktreeDir, ".no-mistakes.yaml")).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the checks config .no-mistakes.yaml: " + String(cause) })),
    Effect.flatMap((text) =>
      readChecksCommands(text, ".no-mistakes.yaml").pipe(
        Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
      )
    )
  )

const finishAfterChecks = (run: HistoryRun, base: { readonly runId: string; readonly runDir: string; readonly branch: string; readonly agentPath: string; readonly agentSource: string; readonly model: string; readonly sessionId: string | null; readonly sessionFile: string | null; readonly tokens: PiTokenUse | null; readonly sessionSize: LongSessionCounts | null; readonly markerVerified: boolean; readonly implementPassed: boolean; readonly prLink: null; readonly noMistakes: null }, commits: Array<OrcRunCommit>, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, allow: ReadonlyArray<AllowWord>, answers: ReadonlyArray<QuestionAnswer>, checkpoints: RunCheckpoints): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    yield* checkpoints.noMistakesStart(new Date().toISOString())
    const noMistakes = yield* driveNoMistakes({ runner: run.noMistakes, taskFile: run.taskPath, allow, answers })
    yield* checkpoints.noMistakesDone(noMistakes)
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

type ImplementBase = Parameters<typeof finishAfterChecks>[1]

const runChecksFixLoop = (
  run: HistoryRun,
  ops: SandboxOps,
  base: ImplementBase,
  rounds: Array<ChecksRoundSummary>,
  fixes: Array<RecordedFixAttempt>,
  commits: Array<OrcRunCommit>,
  plan: ResumePlan,
  checkpoints: RunCheckpoints
): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    for (let round = 1; round <= maxFixAttempts + 1; round += 1) {
      const started = new Date().toISOString()
      yield* checkpoints.checksRoundStart(round, started)
      const commands = yield* readProjectChecks(run)
      const outcome = yield* runChecksRound(ops.execCheck, run.fs, run.path, run.piSessionDir, round, commands).pipe(
        Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
      )
      const ended = new Date().toISOString()
      const failed = outcome.outcomes.filter((check) => !check.passed).map((check) => check.name)
      const summary: ChecksRoundSummary = {
        round,
        file: outcome.file,
        started,
        ended,
        passed: failed.length === 0,
        failed,
        checks: outcome.outcomes.map((check) => ({ name: check.name, passed: check.passed }))
      }
      rounds.push(summary)
      yield* checkpoints.checksRoundDone(summary)
      if (failed.length === 0) {
        return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints)
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
      const attempt = fixes.length + 1
      yield* checkpoints.fixStart(attempt, new Date().toISOString())
      const fixed = yield* fixOnce(run, ops.runAgent, outcome.file, attempt, attempt === 1 ? plan.fixSessionId : null)
      fixes.push(fixed.fix)
      yield* checkpoints.fixDone(fixed.fix)
      commits.push(...fixed.commits)
    }
    return yield* new OrcRunError({ message: "orc: the checks loop ended without a result" })
  })

export const runFull = (run: HistoryRun, ops: SandboxOps, resume: ResumePlan, checkpoints: RunCheckpoints): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const plan = resume
    const implementStarted = run.started
    const done = plan.skipImplement
      ? yield* resumedOutcome(run, plan.implementSessionId, plan.implementSessionFile)
      : yield* Effect.gen(function*() {
        yield* checkpoints.implementStart(implementStarted)
        const outcome = yield* implement(run, ops.runAgent, plan)
        yield* checkpoints.implementDone(outcome, implementStarted, new Date().toISOString())
        return outcome
      })
    const base: ImplementBase = {
      runId: run.runId,
      runDir: run.runDir,
      branch: run.branch,
      agentPath: run.agent.path,
      agentSource: run.agent.source,
      model: run.agent.model,
      sessionId: done.sessionId,
      sessionFile: done.sessionFile,
      tokens: done.tokens,
      sessionSize: done.sessionSize,
      markerVerified: done.markerVerified,
      implementPassed: done.completed,
      prLink: null,
      noMistakes: null
    }
    if (!done.completed) {
      return { ...base, commits: done.commits, completed: false, checksRounds: null, fixes: [], fixAttempts: 0, endReason: done.endReason }
    }
    const rounds: Array<ChecksRoundSummary> = [...plan.inheritedRounds]
    const fixes: Array<RecordedFixAttempt> = [...plan.inheritedFixes]
    const commits = [...done.commits]
    if (plan.skipChecks) {
      return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints)
    }
    return yield* runChecksFixLoop(run, ops, base, rounds, fixes, commits, plan, checkpoints)
  })
