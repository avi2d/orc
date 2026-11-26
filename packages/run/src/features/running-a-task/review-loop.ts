import { Effect } from "effect"
import { distinctRefusals } from "../../entities/run-history/index"
import { OrcRunError } from "../../shared/lib/index"
import { runChecksRound } from "./checks"
import { finishAfterChecks, reviewOrc } from "./run-finish"
import { runReviewTurn } from "./review-turn"
import type { ReviewFinding, ReviewOutcome } from "./review-outcome"
import type { fixOnce as fixReviewOnce, readProjectChecks as readReviewChecks } from "./run-loop"
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
  readonly fixOnce: typeof fixReviewOnce
  readonly readProjectChecks: typeof readReviewChecks
}

const findingsForRound = (findings: ReadonlyArray<ReviewFinding>, round: number): ReadonlyArray<ReviewFinding> =>
  round === 1 ? findings : findings.filter((finding) => finding.severity === "error")

const mayStartRound = (round: number, review: ReviewOutcome): boolean =>
  round <= 2 && review.status === "passed" && findingsForRound(review.findings, round).length > 0

const stopReport = (loop: ReviewLoop, endReason: string): OrcRunReport => ({
  ...loop.base, commits: loop.commits, completed: false, checksRounds: loop.rounds,
  fixes: loop.fixes, fixAttempts: loop.fixes.length, endReason
})

const checkAfterFix = (loop: ReviewLoop): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    const { run, ops, checkpoints, rounds } = loop
    const round = rounds.length + 1
    const started = new Date().toISOString()
    yield* checkpoints.checksRoundStart(round, started)
    const commands = yield* loop.readProjectChecks(run, round)
    const outcome = yield* runChecksRound(ops.execCheck, run.fs, run.path, run.piSessionDir, round, commands).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
    )
    const failed = outcome.outcomes.filter((check) => !check.passed).map((check) => check.name)
    const summary: ChecksRoundSummary = {
      round, file: outcome.file, started, ended: new Date().toISOString(),
      passed: outcome.outcomes.length > 0 && failed.length === 0, failed,
      checks: outcome.outcomes.map((check) => ({ name: check.name, passed: check.passed })),
      refusals: distinctRefusals(outcome.outcomes.flatMap((check) => check.refusals))
    }
    rounds.push(summary)
    yield* checkpoints.checksRoundDone(summary)
    return failed.length === 0 ? null : "The " + failed.join(", ") + " check failed after the review fix. No PR opens."
  })

const runOneRound = (loop: ReviewLoop, findings: ReadonlyArray<ReviewFinding>, round: number): Effect.Effect<string | null, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    const { run, ops, checkpoints, fixes, commits } = loop
    const evidence = run.path.join(run.runDir, "review-fix-" + round.toString() + ".json")
    yield* run.fs.writeFileString(evidence, JSON.stringify(findings, null, 2) + "\n").pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write review findings: " + String(cause) }))
    )
    const attempt = fixes.length + 1
    yield* checkpoints.fixStart(attempt, new Date().toISOString())
    const fixed = yield* loop.fixOnce(run, ops.runAgent, evidence, attempt, null, checkpoints, null, true)
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
    const reviewer = run.delivery.reviewer
    let review = yield* reviewOrc(run, reviewer, checkpoints, ops.runAgent)
    for (let round = 1; mayStartRound(round, review); round += 1) {
      if (review.status !== "passed") break
      const failure = yield* runOneRound(loop, findingsForRound(review.findings, round), round)
      if (failure !== null) return stopReport(loop, failure)
      review = yield* runReviewTurn(run, ops.runAgent, reviewer, "orc")
    }
    return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints, ops.runAgent, plan.priorDir, review)
  })
