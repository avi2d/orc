import { Effect, FileSystem, Schema } from "effect"
import { ReviewerWait, reviewerWaitFileName } from "../../entities/run-history/index"
import { readJsonFileIfPresent } from "../../shared/config/index"
import { OrcRunError } from "../../shared/lib/index"
import { runGit } from "../../shared/process/index"
import { RecordedReview } from "./review-outcome"
import type { HistoryRun } from "./run-record"

const ReviewWaitCheckpoint = Schema.Struct({
  ...ReviewerWait.fields,
  head: Schema.NonEmptyString,
  sentPerRound: Schema.Array(RecordedReview.fields.findings)
})
export type ReviewWaitCheckpoint = typeof ReviewWaitCheckpoint.Type

export const reviewHead = Effect.fnUntraced(function*(run: HistoryRun) {
  const head = yield* runGit(run.spawner, run.git, ["rev-parse", "--verify", "HEAD"], run.worktreeDir)
  if (head.exitCode !== 0 || head.stdout.trim() === "") {
    return yield* new OrcRunError({ message: "orc: cannot read the branch head for reviewer quota: " + head.stderr.trim() })
  }
  return head.stdout.trim()
})

export const readReviewWait = (run: HistoryRun, priorDir: string): Effect.Effect<ReviewWaitCheckpoint | null, OrcRunError> =>
  readJsonFileIfPresent(run.path.join(priorDir, reviewerWaitFileName), ReviewWaitCheckpoint).pipe(
    Effect.provideService(FileSystem.FileSystem, run.fs),
    Effect.mapError(({ file, detail }) => new OrcRunError({ message: "orc: cannot read " + file + ": " + detail }))
  )

export const writeReviewWait = (run: HistoryRun, checkpoint: ReviewWaitCheckpoint): Effect.Effect<void, OrcRunError> => {
  const file = run.path.join(run.runDir, reviewerWaitFileName)
  return run.fs.writeFileString(file, JSON.stringify(checkpoint) + "\n").pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + file + ": " + cause.message }))
  )
}
