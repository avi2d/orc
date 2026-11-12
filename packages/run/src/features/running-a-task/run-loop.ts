import { Effect, FileSystem, Result } from "effect"
import { waitForAnswers } from "../../entities/review-gate/index"
import { buildFixPrompt, maxFixAttempts, readChecksCommands, runChecksRound, type ChecksCommand } from "./checks"
import { distinctRefusals } from "../../entities/run-history/index"
import { branchCommits, runGit } from "../../shared/process/index"
import { buildImplementPrompt, finalReplyError, finalReplyText, orcCompletionLine, orcSplitLine, sessionPrintedSignal, sumPiUsage, textAfterSignal, type PiTokenUse } from "../../entities/agent/index"
import { readPlanDocument, splitReasonPrefix } from "../../entities/backlog/index"
import { idleSpan, type PiEnd } from "../../entities/agent/index"
import { OrcRunError } from "../../shared/lib/index"
import { driveNoMistakes, type AllowWord, type QuestionAnswer } from "../../entities/review-gate/index"
import { askOnLoop, loopAnswerOf, loopContinuePrompt, loopGuidance, loopingNote, RunStopped } from "./loop-pause"
import { type DirectPrRecord, openDirectPr, type PullRequestOpener } from "../../entities/pull-request/index"
import { readFailure } from "../../shared/config/index"
import { countSessionSize, handoverImplementPrompt, type LongSessionCounts } from "../../entities/agent/index"
import type { AgentOutcome, AgentRun, AgentRunResult, AgentStep, ResumePlan, RunCheckpoints, SandboxOps } from "./run-ops"
import { prBodyFileName, type ChecksRoundSummary, type HistoryRun, type OrcRunCommit, type OrcRunReport, type RecordedFixAttempt } from "./run-record"


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
  end.kind === "idle" ? "orc stopped Pi, idle for " + idleSpan(end.idleSeconds) + " with no tool running." : end.kind === "looping" ? loopingNote(end) : null

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

// Each pass of Pi counts commits from the head it started on, so the passes of one step add up.
const runSettled = (
  run: HistoryRun,
  runAgent: SandboxOps["runAgent"],
  first: AgentRun,
  step: AgentStep,
  loopAsked: RunCheckpoints["loopAsked"]
): Effect.Effect<AgentRunResult, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const made: Array<{ readonly sha: string }> = []
    let next = first
    for (;;) {
      const result = yield* runAgent(next)
      made.push(...result.commits)
      if (result.end.kind !== "looping") {
        return { ...result, commits: made }
      }
      const verdict = yield* askOnLoop(run.runDir, run.answerWaitSeconds ?? 0, result.end).pipe(Effect.provideService(FileSystem.FileSystem, run.fs))
      if (verdict.kind === "stop") {
        return yield* new RunStopped({ reason: verdict.reason })
      }
      if (verdict.kind === "unanswered") {
        yield* loopAsked(step, verdict.question)
        return { ...result, commits: made }
      }
      next = { ...first, prompt: loopContinuePrompt(verdict.words), resumeSession: result.sessionFile ?? next.resumeSession }
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

const implementPrompt = (run: HistoryRun, plan: Pick<ResumePlan, "handover" | "implementSessionFile" | "answers">): string => {
  const loop = loopAnswerOf(plan.answers)
  if (loop?.kind === "continue" && plan.implementSessionFile !== null) {
    return loopContinuePrompt(loop.words)
  }
  const taskFile = run.path.join(run.piSessionDir, "task.md")
  const base = plan.handover === null ? buildImplementPrompt(run.agent, taskFile) : handoverImplementPrompt(run.agent, taskFile, plan.handover)
  return loop?.kind === "continue" ? base + "\n" + loopGuidance(loop.words) : base
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
  plan: Pick<ResumePlan, "implementSessionId" | "implementSessionFile" | "handover" | "answers">,
  checkpoints: Pick<RunCheckpoints, "implementSession" | "loopAsked">
): Effect.Effect<AgentOutcome, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const first: AgentRun = { agent: run.agent, prompt: implementPrompt(run, plan), logFile: "agent.log", resumeSession: plan.implementSessionFile, onSession: checkpoints.implementSession }
    const result = yield* runSettled(run, runAgent, first, { name: "implement", attempt: 1 }, checkpoints.loopAsked)
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
  resumed: { readonly session: string; readonly guidance: string | null } | null,
  checkpoints: Pick<RunCheckpoints, "fixSession" | "loopAsked">,
  continuationWords: string | null = null
): Effect.Effect<{ readonly fix: RecordedFixAttempt; readonly commits: ReadonlyArray<OrcRunCommit>; readonly paused: string | null }, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    const prompt = resumed !== null && continuationWords !== null
      ? loopContinuePrompt(continuationWords)
      : buildFixPrompt(run.fixer, evidenceFile) + (resumed?.guidance == null ? "" : "\n" + resumed.guidance)
    const first: AgentRun = { agent: run.fixer, prompt, logFile: "fix-" + attempt.toString() + ".log", resumeSession: resumed?.session ?? null, onSession: (file) => checkpoints.fixSession(attempt, file) }
    const result = yield* runSettled(run, runAgent, first, { name: "fix", attempt }, checkpoints.loopAsked)
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
      commits: session.commits,
      paused: result.end.kind === "looping" ? session.failure : null
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
    const waiting = waitSeconds === 0 ? {} : { waitForAnswers: waitForAnswers(run.runDir, waitSeconds, "no-mistakes") }
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

const resumedFix = (plan: Pick<ResumePlan, "fixSessionFile" | "answers">): { readonly session: string; readonly guidance: string | null } | null => {
  if (plan.fixSessionFile === null) {
    return null
  }
  const loop = loopAnswerOf(plan.answers)
  return { session: plan.fixSessionFile, guidance: loop?.kind === "continue" ? loopGuidance(loop.words) : null }
}

const retryParkedFix = (run: HistoryRun, ops: SandboxOps, base: ImplementBase, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, commits: Array<OrcRunCommit>, plan: ResumePlan, checkpoints: RunCheckpoints): Effect.Effect<OrcRunReport | null, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const pending = resumedFix(plan)
    const loop = loopAnswerOf(plan.answers)
    const prior = fixes.length > 0 ? fixes[fixes.length - 1] : undefined
    if (prior === undefined || prior.status !== "failed" || loop?.kind !== "continue" || pending === null) return null
    fixes.pop()
    yield* checkpoints.fixStart(prior.attempt, new Date().toISOString())
    const retried = yield* fixOnce(run, ops.runAgent, prior.evidenceIn, prior.attempt, pending, checkpoints, loop.words)
    fixes.push(retried.fix)
    yield* checkpoints.fixDone(retried.fix)
    commits.push(...retried.commits)
    return retried.paused === null ? null : { ...base, commits, completed: false, checksRounds: rounds, fixes, fixAttempts: fixes.length, endReason: retried.paused }
  })

const runChecksFixLoop = (
  run: HistoryRun,
  ops: SandboxOps,
  base: ImplementBase,
  rounds: Array<ChecksRoundSummary>,
  fixes: Array<RecordedFixAttempt>,
  commits: Array<OrcRunCommit>,
  plan: ResumePlan,
  checkpoints: RunCheckpoints
): Effect.Effect<OrcRunReport, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const resumed = yield* retryParkedFix(run, ops, base, rounds, fixes, commits, plan, checkpoints)
    if (resumed !== null) {
      return resumed
    }
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
      const fixed = yield* fixOnce(run, ops.runAgent, outcome.file, attempt, attempt === 1 ? resumedFix(plan) : null, checkpoints)
      fixes.push(fixed.fix)
      yield* checkpoints.fixDone(fixed.fix)
      commits.push(...fixed.commits)
      if (fixed.paused !== null) {
        return { ...base, commits, completed: false, checksRounds: rounds, fixes, fixAttempts: fixes.length, endReason: fixed.paused }
      }
    }
    return yield* new OrcRunError({ message: "orc: the checks loop ended without a result" })
  })

export const runFull = (run: HistoryRun, ops: SandboxOps, resume: ResumePlan, checkpoints: RunCheckpoints): Effect.Effect<OrcRunReport, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const plan = resume
    const parkedLoop = loopAnswerOf(plan.answers)
    if (parkedLoop?.kind === "stop") {
      return yield* new RunStopped({ reason: parkedLoop.reason })
    }
    const implementStarted = run.started
    const done = plan.skipImplement
      ? yield* resumedOutcome(run, plan.implementSessionId, plan.implementSessionFile)
      : yield* Effect.gen(function*() {
        yield* checkpoints.implementStart(implementStarted)
        const outcome = yield* implement(run, ops.runAgent, plan, checkpoints)
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
