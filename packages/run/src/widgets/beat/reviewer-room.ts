import { Effect, type FileSystem, type Path, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, backlogRoot } from "../../entities/backlog/index"
import { readDispatchConfig, type RoomReading } from "../../shared/config/index"
import { readQuota, roomOnCredential } from "./quota"

export const readReviewerRoom = (
  orcHome: string
): Effect.Effect<RoomReading, never, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readDispatchConfig(backlogPaths(backlogRoot(orcHome)).dispatchConfig).pipe(Effect.result)
    if (Result.isFailure(config)) {
      const reason = "orc cannot read " + config.failure.file + ": " + config.failure.detail
      const noRoom: RoomReading = () => ({ kind: "no-room", reason })
      return noRoom
    }
    const { quota } = config.success
    const reading = yield* readQuota(quota)
    const roomOf: RoomReading = (reviewer) => roomOnCredential(reading, quota, reviewer)
    return roomOf
  })
