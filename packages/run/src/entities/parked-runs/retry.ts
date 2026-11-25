import { Effect, FileSystem } from "effect"
import { BacklogError, grabIn, parentBranch, parseTaskFile, platformFailure, publishOnce, renderTaskFile, taskBranch, type TaskFileError, type TaskRecord } from "../backlog/index"

export const retryStartedTask = (
  root: string,
  id: string,
  machine: string,
  run: string,
  at: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "taken", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it" })))
    const retry = Effect.gen(function*() {
      const record = yield* parseTaskFile(file, "taken", yield* read)
      if (record.state.kind !== "started" || record.state.claim.machine !== machine || record.retry !== undefined) {
        return yield* new BacklogError({ detail: id + " is no longer eligible for retry" })
      }
      const branch = record.parked?.branch ?? (record.spec.kind === "parent" ? parentBranch(id) : taskBranch(id))
      const retried: TaskRecord = {
        ...record,
        retry: { run, at },
        parked: { ...record.parked, branch, questions: record.parked?.questions ?? [], origin: { machine, run } },
        state: { kind: "new" }
      }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(retried)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return retried
    })
    const retried = yield* retry.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return retried
  })
