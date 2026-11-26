import { Effect, FileSystem } from "effect"
import { BacklogError, grabIn, parseTaskFile, platformFailure, publishOnce, ranClosing, renderTaskFile, taskBranch, type Parked, type Rebase, type TaskFileError, type TaskRecord } from "../backlog/index"

export const rebaseClosedTask = (
  root: string,
  id: string,
  rebase: Rebase,
  origin: NonNullable<Parked["origin"]>
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "closed", id, Effect.fail(new BacklogError({ detail: id + " moved before the rebase was queued" })))
    const queue = Effect.gen(function*() {
      const record = yield* parseTaskFile(file, "closed", yield* read)
      if (ranClosing(record)?.pr !== rebase.pr || (record.rebase?.pr === rebase.pr && record.rebase.head === rebase.head)) {
        return yield* new BacklogError({ detail: id + " no longer needs this rebase" })
      }
      const parked: Parked = { branch: taskBranch(id), questions: [], origin: { ...origin, pr: rebase.pr }, at: rebase.at }
      const queued: TaskRecord = { ...record, rebase, parked, state: { kind: "new" } }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(queued)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return queued
    })
    const queued = yield* queue.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return queued
  })
