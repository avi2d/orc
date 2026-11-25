import { Effect, FileSystem } from "effect"
import { BacklogError, findTask, grabIn, parseTaskFile, platformFailure, publishOnce, renderTaskFile, type TaskFileError } from "../../entities/backlog/index"

export const retryTask = (root: string, id: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    if (record.state.kind !== "closed" || (record.state.closing.outcome !== "failed" && record.state.closing.outcome !== "stopped" && record.state.closing.outcome !== "start-failed")) {
      return yield* new BacklogError({ detail: id + " is not a failed or stopped task" })
    }
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "closed", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" })))
    const retry = Effect.gen(function*() {
      const fresh = yield* parseTaskFile(file, "closed", yield* read)
      if (fresh.state.kind !== "closed" || (fresh.state.closing.outcome !== "failed" && fresh.state.closing.outcome !== "stopped" && fresh.state.closing.outcome !== "start-failed")) {
        return yield* new BacklogError({ detail: id + " is not a failed or stopped task" })
      }
      const machine = fresh.state.closing.outcome === "start-failed"
        ? fresh.parked?.origin?.machine ?? fresh.spec.machine
        : fresh.state.claim?.machine ?? fresh.spec.machine
      const next = { ...fresh, spec: { ...fresh.spec, machine }, parked: null, state: { kind: "new" as const } }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(next)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return machine === null ? id + " will start again" : id + " will run again on " + machine
    })
    const result = yield* retry.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return result
  })
