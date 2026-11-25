import { DateTime, Effect, FileSystem } from "effect"
import { BacklogError, findTask, fullPrUrl, grabIn, parseTaskFile, platformFailure, publishOnce, renderTaskFile, type TaskFileError, taskPr, type TaskRecord } from "../../entities/backlog/index"
import { withdrawTaskItems } from "../../entities/attention/index"

const retryState = (record: TaskRecord) => {
  const state = record.state
  return state.kind === "closed" && (state.closing.outcome === "failed" || state.closing.outcome === "stopped" || state.closing.outcome === "start-failed") ? state : null
}

export const retryTask = (root: string, id: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    if (retryState(record) === null) {
      return yield* new BacklogError({ detail: id + " is not a failed or stopped task" })
    }
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "closed", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" })))
    const retry = Effect.gen(function*() {
      const fresh = yield* parseTaskFile(file, "closed", yield* read)
      const state = retryState(fresh)
      if (state === null) {
        return yield* new BacklogError({ detail: id + " is not a failed or stopped task" })
      }
      const pr = fullPrUrl(taskPr(fresh)) ?? fullPrUrl(fresh.priorPr) ?? fullPrUrl(fresh.parked?.origin?.pr)
      const next = {
        ...fresh,
        ...(state.closing.outcome === "start-failed" ? {} : {
          spec: { ...fresh.spec, machine: state.claim?.machine ?? fresh.spec.machine },
          parked: null,
          ...(pr === null ? {} : { priorPr: pr })
        }),
        state: { kind: "new" as const }
      }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(next)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      const targetMachine = next.parked?.origin?.machine ?? next.spec.machine
      return targetMachine === null ? id + " will start again" : id + " will run again on " + targetMachine
    })
    const result = yield* retry.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    const now = yield* DateTime.now
    yield* withdrawTaskItems(root, [id], DateTime.formatIso(now))
    return result
  })
