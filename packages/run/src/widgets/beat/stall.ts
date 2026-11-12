import { DateTime, Effect, FileSystem, Option } from "effect"
import { backlogPaths, type BacklogError, platformFailure, type TaskRecord } from "../../entities/backlog/index"
import type { StalledAction } from "../../entities/attention/index"
import { stallEvent } from "./task-events"
import type { Progress } from "../../entities/attention/index"

export const stallMillis = 30 * 60 * 1000

export const logWrittenAt = (log: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(log).pipe(Effect.orElseSucceed(() => null))
    return info === null ? null : Option.match(info.mtime, { onNone: () => null, onSome: (mtime) => mtime.toISOString() })
  })

const writtenAt = (task: TaskRecord, progress: Progress): Effect.Effect<string | null, never, FileSystem.FileSystem> => {
  if (progress.kind === "running") {
    return Effect.succeed(progress.outputAt)
  }
  return progress.kind === "own-log" && task.state.kind === "started" ? logWrittenAt(task.state.started.log) : Effect.succeed(null)
}

// The stall file keeps the write time it flagged, so one stall flags once and a log written since flags anew.
export const flagStall = (root: string, task: TaskRecord, progress: Progress): Effect.Effect<Option.Option<StalledAction>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (task.state.kind !== "started") {
      return Option.none()
    }
    const fs = yield* FileSystem.FileSystem
    const file = backlogPaths(root).stallFile(task.spec.id)
    if (progress.kind === "ended") {
      if (progress.action.kind === "close-failed") {
        return Option.none()
      }
      yield* fs.remove(file, { force: true }).pipe(Effect.mapError(platformFailure("remove " + file)))
      return Option.none()
    }
    const since = yield* writtenAt(task, progress)
    const now = yield* DateTime.now
    if (since === null || DateTime.toEpochMillis(now) - Date.parse(since) < stallMillis) {
      return Option.none()
    }
    const flagged = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError(platformFailure("read " + file))
    )
    if (flagged === since) {
      return Option.none()
    }
    const stall = { kind: "stalled", task: task.spec.id, machine: task.state.claim.machine, since } satisfies StalledAction
    yield* stallEvent(root, task, stall, DateTime.formatIso(now))
    yield* fs.writeFileString(file, since).pipe(Effect.mapError(platformFailure("write " + file)))
    return Option.some(stall)
  })
