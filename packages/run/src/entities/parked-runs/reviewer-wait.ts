import { Effect, FileSystem } from "effect"
import type { ReviewerWait } from "../../shared/config/index"
import { BacklogError, grabIn, parentBranch, parseTaskFile, platformFailure, publishOnce, renderTaskFile, taskBranch, type TaskFileError, type TaskRecord } from "../backlog/index"

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
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "taken", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it" })))
    const park = Effect.gen(function*() {
      const record = yield* parseTaskFile(file, "taken", yield* read)
      if (record.state.kind !== "started" || record.state.claim.machine !== machine) {
        return yield* new BacklogError({ detail: id + " is no longer the run that waits for a reviewer" })
      }
      const branch = record.parked?.branch ?? (record.spec.kind === "parent" ? parentBranch(id) : taskBranch(id))
      const sentPr = record.parked?.origin?.pr
      const parked: TaskRecord = {
        ...record,
        parked: { ...record.parked, branch, questions: record.parked?.questions ?? [], origin: { machine, run, ...(sentPr === undefined ? {} : { pr: sentPr }) }, at, reviewerWait: wait },
        state: { kind: "new" }
      }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(parked)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return parked
    })
    const parked = yield* park.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return parked
  }).pipe(Effect.uninterruptible)
