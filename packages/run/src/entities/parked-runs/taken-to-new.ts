import { Effect, FileSystem } from "effect"
import { BacklogError, grabIn, parentBranch, parseTaskFile, platformFailure, publishOnce, renderTaskFile, taskBranch, type Parked, type TaskFileError, type TaskRecord } from "../backlog/index"

export const parkedBranch = (record: TaskRecord, id: string): string =>
  record.parked?.branch ?? (record.spec.kind === "parent" ? parentBranch(id) : taskBranch(id))

export const originOfRun = (record: TaskRecord, machine: string, run: string): NonNullable<Parked["origin"]> => {
  const sentPr = record.parked?.origin?.pr
  return { machine, run, ...(sentPr === undefined ? {} : { pr: sentPr }) }
}

export const takenToNew = (
  root: string,
  id: string,
  missed: string,
  rewrite: (record: TaskRecord) => Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem>
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "taken", id, Effect.fail(new BacklogError({ detail: id + " " + missed })))
    const move = Effect.gen(function*() {
      const rewritten = yield* rewrite(yield* parseTaskFile(file, "taken", yield* read))
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(rewritten)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return rewritten
    })
    const moved = yield* move.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return moved
  }).pipe(Effect.uninterruptible)
