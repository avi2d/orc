import { Effect } from "effect"
import { OrcRunError } from "../../shared/lib/index"
import { runChecksRound, summarizeChecksRound, type ChecksCommand } from "./checks"
import { finishAfterChecks, reviewOrc } from "./run-finish"
import type { ReviewFinding } from "./review-outcome"
import { passesRoundTwoBar, sameFinding, type ReviewStop } from "./left-findings"
import type { RunStopped } from "./loop-pause"
import type { ResumePlan, RunCheckpoints, SandboxOps } from "./run-ops"
import type { ChecksRoundSummary, HistoryRun, OrcRunCommit, OrcRunReport, RecordedFixAttempt } from "./run-record"

interface ReviewLoop {
  readonly run: HistoryRun
  readonly ops: SandboxOps
  readonly base: Parameters<typeof finishAfterChecks>[1]
  readonly rounds: Array<ChecksRoundSummary>
  readonly fixes: Array<RecordedFixAttempt>
  readonly commits: Array<OrcRunCommit>
  readonly plan: ResumePlan
  readonly checkpoints: RunCheckpoints
  readonly fixReview: (evidence: string, attempt: number) => Effect.Effect<{ readonly fix: RecordedFixAttempt; readonly commits: ReadonlyArray<OrcRunCommit>; readonly paused: string | null }, OrcRunError | RunStopped>
  readonly readChecks: (round: number) => Effect.Effect<ReadonlyArray<ChecksCommand>, OrcRunError>
}

const findingsForRound = (findings: ReadonlyArray<ReviewFinding>, round: number): ReadonlyArray<ReviewFinding> =>
  findings.filter((finding) => finding.action !== "ask-user" && (round === 1 || passesRoundTwoBar(finding)))

const stopForReview = (findings: ReadonlyArray<ReviewFinding>, round: number, limit: number, sent: ReadonlyArray<ReadonlyArray<ReviewFinding>>): ReviewStop | null => {
  const unresolved = findings.filter((finding) => finding.action !== "ask-user" && (finding.severity === "error" || finding.severity === "warning"))
  if (unresolved.length === 0) return "cleared"
  if (round > limit) return "round-limit"
  const eligible = findingsForRound(findings, round)
  if (eligible.some((finding) => sent.some((previous) => previous.some((earlier) => sameFinding(earlier, finding))))) return "repeat"
  if (eligible.length === 0) return "severity-bar"
  return null
}

const collectAskUser = (kept: Array<ReviewFinding>, findings: ReadonlyArray<ReviewFinding>): void => {
  for (const finding of findings) {
    const earlier = kept.findIndex((held) => sameFinding(held, finding))
    if (finding.action !== "ask-user") {
      if (earlier !== -1) kept.splice(earlier, 1)
    } else if (earlier === -1) kept.push(finding)
    else kept[earlier] = finding
  }
}

const stopReport = (loop: ReviewLoop, endReason: string): OrcRunReport => ({
  ...loop.base, commits: loop.commits, completed: false, checksRounds: loop.rounds,
  fixes: loop.fixes, fixAttempts: loop.fixes.length, endReason
})

export const runRecordedChecks = (
  run: HistoryRun,
  ops: SandboxOps,
  checkpoints: RunCheckpoints,
  rounds: Array<ChecksRoundSummary>,
  round: number,
  readChecks: ReviewLoop["readChecks"]
): Effect.Effect<ChecksRoundSummary, OrcRunError> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    yield* checkpoints.checksRoundStart(round, started)
    const commands = yield* readChecks(round)
    const outcome = yield* runChecksRound(ops.execCheck, run.fs, run.path, run.piSessionDir, round, commands).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
    )
    const summary = summarizeChecksRound(outcome, started, new Date().toISOString())
    rounds.push(summary)
    yield* checkpoints.checksRoundDone(summary)
    return summary
  })

const checkAfterFix = (loop: ReviewLoop): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    const { run, ops, checkpoints, rounds, readChecks } = loop
    const summary = yield* runRecordedChecks(run, ops, checkpoints, rounds, rounds.length + 1, readChecks)
    return summary.failed.length === 0 ? null : "The " + summary.failed.join(", ") + " check failed after the review fix. No PR opens."
  })

const runOneRound = (loop: ReviewLoop, findings: ReadonlyArray<ReviewFinding>, round: number): Effect.Effect<string | null, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const { run, checkpoints, fixes, commits } = loop
    const evidence = run.path.join(run.runDir, "review-fix-" + round.toString() + ".json")
    yield* run.fs.writeFileString(evidence, JSON.stringify(findings, null, 2) + "\n").pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write review findings: " + String(cause) }))
    )
    const attempt = fixes.length + 1
    yield* checkpoints.fixStart(attempt, new Date().toISOString())
    const fixed = yield* loop.fixReview(evidence, attempt)
    fixes.push(fixed.fix)
    yield* checkpoints.fixDone(fixed.fix)
    commits.push(...fixed.commits)
    if (fixed.paused !== null || fixed.fix.status === "failed") {
      return fixed.paused ?? "The review fix did not finish. No PR opens."
    }
    return yield* checkAfterFix(loop)
  })

export const finishChecked = (loop: ReviewLoop): Effect.Effect<OrcRunReport, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const { run, ops, base, rounds, fixes, commits, plan, checkpoints } = loop
    if (run.delivery.kind !== "orc") {
      return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints, ops.runAgent, plan.priorDir)
    }
    const limit = run.delivery.maxFixRounds
    const reviewer = run.delivery.reviewer
    let review = yield* reviewOrc(run, reviewer, checkpoints, ops.runAgent, 1)
    const sentPerRound: Array<ReadonlyArray<ReviewFinding>> = []
    const askUserFindings: Array<ReviewFinding> = []
    let round = 1
    while (review.status === "passed") {
      collectAskUser(askUserFindings, review.findings)
      const stop = stopForReview(review.findings, round, limit, sentPerRound)
      if (stop !== null) {
        return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints, ops.runAgent, plan.priorDir, { review, sentPerRound, stop, askUserFindings })
      }
      const sent = findingsForRound(review.findings, round)
      sentPerRound.push(sent)
      const failure = yield* runOneRound(loop, sent, round)
      if (failure !== null) return stopReport(loop, failure)
      round += 1
      review = yield* reviewOrc(run, reviewer, checkpoints, ops.runAgent, round)
    }
    return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints, ops.runAgent, plan.priorDir, { review })
  })
