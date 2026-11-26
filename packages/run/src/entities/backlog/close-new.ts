import { Effect, FileSystem } from "effect"
import { parseTaskFile, type TaskFileError, type TaskRecord } from "./task-record"
import { renderTaskFile } from "./task-record-render"
import { BacklogError, newGrab, platformFailure, publishOnce } from "./backlog-write"

// rename(2) takes the one task file at most once, so two closers never both get the task.
export const closeNewTask = (
  root: string,
  id: string,
  closeWith: (fresh: TaskRecord) => TaskRecord | string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* newGrab(root, id)
    const settle = Effect.gen(function*() {
      const closed = closeWith(yield* parseTaskFile(file, "new", yield* read))
      if (typeof closed === "string") {
        return yield* new BacklogError({ detail: closed })
      }
      if (!(yield* publishOnce(paths.folder("closed"), id + ".md", renderTaskFile(closed)))) {
        return yield* new BacklogError({ detail: id + " was closed by another command" })
      }
      return closed
    })
    const closed = yield* settle.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return closed
  }).pipe(Effect.uninterruptible)
