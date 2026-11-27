import { Effect, FileSystem } from "effect"
import { reviewerWaitFileName } from "../../entities/run-history/index"
import { readJsonFileIfPresent } from "../../shared/config/index"
import { OrcRunError } from "../../shared/lib/index"
import { ReviewWaitCheckpoint } from "./review-wait-checkpoint"
import type { HistoryRun } from "./run-record"

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
