import { Effect, FileSystem, Result } from "effect"
import { waitForAnswers } from "../../entities/review-gate/index"
import type { AgentFile } from "../../entities/agent/index"
import { buildFixPrompt, maxFixAttempts, readChecksCommands, runChecksRound, type ChecksCommand } from "./checks"
import { type CommandResult } from "../../shared/sandbox/index"
import { distinctRefusals } from "../../entities/run-history/index"
import { branchCommits, runGit } from "../../shared/process/index"
import { buildImplementPrompt, finalReplyError, finalReplyText, orcCompletionLine, orcSplitLine, sessionPrintedSignal, sumPiUsage, textAfterSignal, type PiTokenUse } from "../../entities/agent/index"
import { readPlanDocument, splitReasonPrefix } from "../../entities/backlog/index"
import { idleSpan, type PiEnd, type PiRun } from "../../entities/agent/index"
import { OrcRunError } from "../../shared/lib/index"
import { driveNoMistakes, type AllowWord, type NoMistakesRecord, type QuestionAnswer } from "../../entities/review-gate/index"
import { type DirectPrRecord, openDirectPr, type PullRequestOpener } from "../../entities/pull-request/index"
import { readFailure } from "../../shared/config/index"
import { countSessionSize, handoverImplementPrompt, type LongSessionCounts } from "../../entities/agent/index"
import { prBodyFileName, type ChecksRoundSummary, type HistoryRun, type OrcRunCommit, type OrcRunReport, type RecordedFixAttempt } from "./run-record"

export interface AgentRun {
  readonly agent: AgentFile
  readonly prompt: string
  readonly logFile: string
  readonly resumeSession: string | null
  readonly onSession: (file: string) => Effect.Effect<void, OrcRunError>
}

interface AgentRunResult extends PiRun {
  readonly commits: ReadonlyArray<{ readonly sha: string }>
}

export interface SandboxOps {
  readonly runAgent: (run: AgentRun) => Effect.Effect<AgentRunResult, OrcRunError>
  readonly execCheck: (command: string) => Effect.Effect<CommandResult, OrcRunError>
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
  readonly implementSession: (file: string) => Effect.Effect<void, OrcRunError>
  readonly implementDone: (outcome: AgentOutcome, started: string, ended: string) => Effect.Effect<void, OrcRunError>
  readonly checksRoundStart: (round: number, started: string) => Effect.Effect<void, OrcRunError>
  readonly checksRoundDone: (round: ChecksRoundSummary) => Effect.Effect<void, OrcRunError>
  readonly fixStart: (attempt: number, started: string) => Effect.Effect<void, OrcRunError>
  readonly fixSession: (attempt: number, file: string) => Effect.Effect<void, OrcRunError>
  readonly fixDone: (fix: RecordedFixAttempt) => Effect.Effect<void, OrcRunError>
  readonly noMistakesStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly noMistakesDone: (record: NoMistakesRecord) => Effect.Effect<void, OrcRunError>
  readonly pullRequestStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly pullRequestDone: (record: DirectPrRecord) => Effect.Effect<void, OrcRunError>
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

const stoppedNote = (end: PiEnd): string | null =>
  end.kind === "idle" ? "orc stopped Pi, idle for " + idleSpan(end.idleSeconds) + " with no tool running." : null

const exitNote = (end: PiEnd): string =>
  end.kind === "exited" && end.exitCode !== 0 ? " Pi exited with code " + end.exitCode.toString() + "." : ""

const sessionOf = (run: HistoryRun, result: AgentRunResult): Effect.Effect<CapturedAgentRun, OrcRunError> =>
  Effect.gen(function*() {
    const jsonl = result.sessionFile === null ? null : yield* run.fs.readFileString(result.sessionFile).pipe(Effect.orElseSucceed(() => null))
    const commits = yield* collectCommits(run, result.commits)
    return {
      sessionId: result.sessionId,
      sessionFile: jsonl === null ? null : result.sessionFile,
      commits,
      tokens: jsonl === null ? null : sumPiUsage(jsonl),
      failure: stoppedNote(result.end),
      jsonl
    }
  })

const verifiedMarker = (jsonl: string | null): boolean =>
  jsonl !== null && sessionPrintedSignal(jsonl, orcCompletionLine)

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

const splitProposalReason = (jsonl: string | null): string | null => {
  if (jsonl === null || !sessionPrintedSignal(jsonl, orcSplitLine)) return null
  const split = readPlanDocument(textAfterSignal(finalReplyText(jsonl) ?? "", orcSplitLine))
  if (Result.isFailure(split)) return "invalid split proposal: " + split.failure
  return split.success.plan !== "split" ? "invalid split proposal: expected a split" : splitReasonPrefix + JSON.stringify(split.success)
}

const implement = (
  run: HistoryRun,
  runAgent: SandboxOps["runAgent"],
  plan: Pick<ResumePlan, "implementSessionId" | "implementSessionFile" | "handover">,
  onSession: AgentRun["onSession"]
): Effect.Effect<AgentOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const result = yield* runAgent({ agent: run.agent, prompt: implementPrompt(run, plan), logFile: "agent.log", resumeSession: plan.implementSessionFile, onSession })
    const session = yield* sessionOf(run, result)
    const sessionSize = session.jsonl === null ? null : countSessionSize(session.jsonl)
    const verified = verifiedMarker(session.jsonl)
    const prior = plan.implementSessionId === null && plan.handover === null ? [] : yield* resumedCommits(run)
    const seen = new Set(session.commits.map((commit) => commit.sha))
    const commits = [...session.commits, ...prior.filter((commit) => !seen.has(commit.sha))]
    const splitReason = splitProposalReason(session.jsonl)
    const completed = splitReason === null && verified && commits.length > 0
    const endReason = session.failure ?? splitReason ?? (!verified
      ? "Pi's final reply did not stop cleanly with " + orcCompletionLine + " on its own line." + replyErrorNote(session.jsonl) + exitNote(result.end)
      : (commits.length > 0
        ? "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + "."
        : "Pi printed ORC_COMPLETE but made no commit on " + run.branch + "."))
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      commits,
      tokens: session.tokens,
      sessionSize,
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
  resumeSession: string | null,
  onSession: AgentRun["onSession"]
): Effect.Effect<{ readonly fix: RecordedFixAttempt; readonly commits: ReadonlyArray<OrcRunCommit> }, OrcRunError> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    const result = yield* runAgent({ agent: run.fixer, prompt: buildFixPrompt(run.fixer, evidenceFile), logFile: "fix-" + attempt.toString() + ".log", resumeSession, onSession })
    const session = yield* sessionOf(run, result)
    const verified = verifiedMarker(session.jsonl)
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
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the checks config .no-mistakes.yaml: " + readFailure(cause) })),
    Effect.flatMap((text) =>
      readChecksCommands(text, ".no-mistakes.yaml").pipe(
        Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
      )
    )
  )

const finishAfterChecks = (run: HistoryRun, base: { readonly runId: string; readonly runDir: string; readonly branch: string; readonly agentPath: string; readonly agentSource: string; readonly model: string; readonly sessionId: string | null; readonly sessionFile: string | null; readonly tokens: PiTokenUse | null; readonly sessionSize: LongSessionCounts | null; readonly markerVerified: boolean; readonly implementPassed: boolean; readonly prLink: null; readonly noMistakes: null }, commits: Array<OrcRunCommit>, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, allow: ReadonlyArray<AllowWord>, answers: ReadonlyArray<QuestionAnswer>, checkpoints: RunCheckpoints): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const checked = "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + ", and the checks passed. "
    const settled = { ...base, commits, checksRounds: rounds, fixes, fixAttempts: fixes.length }
    if (run.delivery.kind === "direct-PR") {
      const pr = yield* openPullRequest(run, run.delivery.opener, rounds, checkpoints)
      return { ...settled, completed: pr.status === "opened", prLink: pr.prLink, endReason: checked + pr.result }
    }
    yield* checkpoints.noMistakesStart(new Date().toISOString())
    const waitSeconds = run.answerWaitSeconds ?? 0
    const waiting = waitSeconds === 0 ? {} : { waitForAnswers: waitForAnswers(run.runDir, waitSeconds) }
    const noMistakes = yield* driveNoMistakes({ runner: run.delivery.runner, taskFile: run.taskPath, runDir: run.runDir, allow, answers, ...waiting }).pipe(
      Effect.provideService(FileSystem.FileSystem, run.fs)
    )
    yield* checkpoints.noMistakesDone(noMistakes)
    return { ...settled, completed: noMistakes.status === "passed", prLink: noMistakes.prLink, noMistakes, endReason: checked + noMistakes.result }
  })

const prBody = (subjects: ReadonlyArray<string>, rounds: ReadonlyArray<ChecksRoundSummary>): string => {
  const passed = rounds.at(-1)?.checks.map((check) => check.name) ?? []
  const closing = "orc opened this PR after " + (passed.length === 0 ? "the checks" : passed.join(", ")) + " passed, without no-mistakes.\n"
  return subjects.length === 0 ? closing : subjects.map((subject) => "- " + subject).join("\n") + "\n\n---\n\n" + closing
}

const openPullRequest = (
  run: HistoryRun,
  opener: PullRequestOpener,
  rounds: ReadonlyArray<ChecksRoundSummary>,
  checkpoints: RunCheckpoints
): Effect.Effect<DirectPrRecord, OrcRunError> =>
  Effect.gen(function*() {
    yield* checkpoints.pullRequestStart(new Date().toISOString())
    const head = yield* runGit(run.spawner, run.git, ["log", "-1", "--format=%s", run.branch], run.worktreeDir).pipe(
      Effect.map((logged) => logged.stdout.trim()),
      Effect.orElseSucceed(() => "")
    )
    const listed = yield* branchCommits(run.spawner, run.git, run.branch, run.projectDir).pipe(Effect.orElseSucceed(() => [] as Array<OrcRunCommit>))
    const subjects = listed.map((commit) => commit.subject.trim()).filter((subject) => subject !== "")
    const bodySubjects = subjects.length > 0 ? subjects : (head !== "" ? [head] : [])
    const bodyFile = run.path.join(run.runDir, prBodyFileName)
    yield* run.fs.writeFileString(bodyFile, prBody(bodySubjects, rounds)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + bodyFile + ": " + String(cause) }))
    )
    const pr = yield* openDirectPr(opener, run.branch, head !== "" ? head : run.branch, bodyFile)
    yield* checkpoints.pullRequestDone(pr)
    return pr
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
        checks: outcome.outcomes.map((check) => ({ name: check.name, passed: check.passed })),
        refusals: distinctRefusals(outcome.outcomes.flatMap((check) => check.refusals))
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
      const fixed = yield* fixOnce(run, ops.runAgent, outcome.file, attempt, attempt === 1 ? plan.fixSessionFile : null, (file) => checkpoints.fixSession(attempt, file))
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
        const outcome = yield* implement(run, ops.runAgent, plan, checkpoints.implementSession)
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
