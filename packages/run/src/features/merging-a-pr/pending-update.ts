import { Effect, FileSystem, Schema } from "effect"
import { BacklogError, backlogPaths } from "../../entities/backlog/index"
import { type ConfigError, readJsonFileIfPresent, writeWhole } from "../../shared/config/index"

const PendingUpdate = Schema.Struct({
  url: Schema.String,
  head: Schema.String,
  green: Schema.Array(Schema.String)
})
export type PendingUpdate = typeof PendingUpdate.Type

const fileOf = (root: string, id: string): string => backlogPaths(root).logs + "/" + id + ".merge"

export const readPendingUpdate = (root: string, id: string): Effect.Effect<PendingUpdate | null, ConfigError, FileSystem.FileSystem> =>
  readJsonFileIfPresent(fileOf(root, id), PendingUpdate)

export const savePendingUpdate = (root: string, id: string, pending: PendingUpdate): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(backlogPaths(root).logs, { recursive: true }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined)))
    if (!(yield* writeWhole(fileOf(root, id), JSON.stringify(pending)))) {
      return yield* new BacklogError({ detail: "orc merge could not save the branch update it asked for on " + pending.url + ", so it asked for none" })
    }
  })

export const clearPendingUpdate = (root: string, id: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(fileOf(root, id), { force: true }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined)))
  })
