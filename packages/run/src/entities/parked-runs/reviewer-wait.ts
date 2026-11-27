import { Effect, FileSystem } from "effect"
import type { ReviewerWait } from "../../shared/config/index"
import { BacklogError, type TaskFileError, type TaskRecord } from "../backlog/index"
import { originOfRun, parkedBranch, takenToNew } from "./taken-to-new"

export const withoutReviewerWait = (record: TaskRecord): TaskRecord => {
  if (record.parked?.reviewerWait === undefined) {
    return record
  }
  const { reviewerWait: _met, ...parked } = record.parked
  return { ...record, parked }
}

// rename(2) takes the taken file at most once, so of two beats parking one run exactly one moves it back to new.
export const parkForReviewerRoom = (
  root: string,
  id: string,
  machine: string,
  run: string,
  wait: ReviewerWait,
  at: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  takenToNew(root, id, "moved while orc read it", (record) =>
    record.state.kind !== "started" || record.state.claim.machine !== machine
      ? Effect.fail(new BacklogError({ detail: id + " is no longer the run that waits for a reviewer" }))
      : Effect.succeed({
        ...record,
        parked: { ...record.parked, branch: parkedBranch(record, id), questions: record.parked?.questions ?? [], origin: originOfRun(record, machine, run), at, reviewerWait: wait },
        state: { kind: "new" }
      }))
