import { Data, Effect, FileSystem } from "effect"
import type { PlatformError } from "effect/PlatformError"

export class BacklogError extends Data.TaggedError("BacklogError")<{
  readonly detail: string
}> {}

export const platformFailure = (action: string) => (error: PlatformError): BacklogError =>
  new BacklogError({ detail: "cannot " + action + ": " + error.message })

export const scratchName = (folder: string, id: string): string => folder + "/." + id + "." + crypto.randomUUID() + ".tmp"

// link(2) refuses an existing name, so the file appears whole and at most once.
export const publishOnce = (
  folder: string,
  name: string,
  text: string
): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const scratch = scratchName(folder, name)
    const file = folder + "/" + name
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    const published = yield* fs.link(scratch, file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.mapError(platformFailure("write " + file))
    )
    yield* fs.remove(scratch).pipe(Effect.mapError(platformFailure("remove " + scratch)))
    return published
  })
