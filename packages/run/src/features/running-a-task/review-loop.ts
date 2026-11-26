import { Effect } from "effect"
import { distinctRefusals } from "../../entities/run-history/index"
import type { AgentFile } from "../../entities/agent/index"
import { OrcRunError } from "../../shared/lib/index"
import { runChecksRound } from "./checks"
import { finishAfterChecks, reviewOrc } from "./run-finish"
import { runReviewTurn } from "./review-turn"
import type { fixOnce as fixReviewOnce, readProjectChecks as readReviewChecks } from "./run-loop"
import type { RunStopped } from "./loop-pause"
import type { ResumePlan, RunCheckpoints, SandboxOps } from "./run-ops"
import type { ChecksRoundSummary, HistoryRun, OrcRunCommit, OrcRunReport, RecordedFixAttempt } from "./run-record"

export const runOrcReviewLoop = (
  run: HistoryRun,
  ops: SandboxOps,
  base: Parameters<typeof finishAfterChecks>[1],
  rounds: Array<ChecksRoundSummary>,
  fixes: Array<RecordedFixAttempt>,
  commits: Array<OrcRunCommit>,
  plan: ResumePlan,
  checkpoints: RunCheckpoints,
  reviewer: AgentFile,
  fixOnce: typeof fixReviewOnce,
  readProjectChecks: typeof readReviewChecks
): Effect.Effect<OrcRunReport, OrcRunError | RunStopped> =>
  Effect.gen(function*() {
    let review = yield* reviewOrc(run, reviewer, checkpoints, ops.runAgent)
    for (let round = 1; round <= 2 && review.status === "passed"; round += 1) {
      const selected = round === 1
        ? (review.findings.some((finding) => finding.severity === "error" || finding.severity === "warning") ? review.findings : [])
        : review.findings.filter((finding) => finding.severity === "error")
      if (selected.length === 0) break
      const evidence = run.path.join(run.runDir, "review-fix-" + round.toString() + ".json")
      yield* run.fs.writeFileString(evidence, JSON.stringify(selected, null, 2) + "\n").pipe(
        Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write review findings: " + String(cause) }))
      )
      const attempt = fixes.length + 1
      yield* checkpoints.fixStart(attempt, new Date().toISOString())
      const fixed = yield* fixOnce(run, ops.runAgent, evidence, attempt, null, checkpoints, null, true)
      fixes.push(fixed.fix)
      yield* checkpoints.fixDone(fixed.fix)
      commits.push(...fixed.commits)
      if (fixed.paused !== null || fixed.fix.status === "failed") {
        return { ...base, commits, completed: false, checksRounds: rounds, fixes, fixAttempts: fixes.length, endReason: fixed.paused ?? "The review fix did not finish. No PR opens." }
      }
      const checkRound = rounds.length + 1
      const started = new Date().toISOString()
      yield* checkpoints.checksRoundStart(checkRound, started)
      const commands = yield* readProjectChecks(run, checkRound)
      const outcome = yield* runChecksRound(ops.execCheck, run.fs, run.path, run.piSessionDir, checkRound, commands).pipe(
        Effect.mapError((cause) => new OrcRunError({ message: cause.message }))
      )
      const failed = outcome.outcomes.filter((check) => !check.passed).map((check) => check.name)
      const summary: ChecksRoundSummary = {
        round: checkRound, file: outcome.file, started, ended: new Date().toISOString(),
        passed: outcome.outcomes.length > 0 && failed.length === 0, failed,
        checks: outcome.outcomes.map((check) => ({ name: check.name, passed: check.passed })),
        refusals: distinctRefusals(outcome.outcomes.flatMap((check) => check.refusals))
      }
      rounds.push(summary)
      yield* checkpoints.checksRoundDone(summary)
      if (failed.length > 0) {
        return { ...base, commits, completed: false, checksRounds: rounds, fixes, fixAttempts: fixes.length, endReason: "The " + failed.join(", ") + " check failed after the review fix. No PR opens." }
      }
      review = yield* runReviewTurn(run, ops.runAgent, reviewer, "orc")
    }
    return yield* finishAfterChecks(run, base, commits, rounds, fixes, plan.allow, plan.answers, checkpoints, ops.runAgent, plan.priorDir, review)
  })

