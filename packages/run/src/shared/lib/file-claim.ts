import { Console, Effect, FileSystem, Option } from "effect"

import type { PlatformError } from "effect/PlatformError"

export const withFileClaim = <A, E, R>(file: string, use: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E | PlatformError, R | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.acquireUseRelease(
      fs.writeFileString(file, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false))
      ),
      (claimed) => claimed ? Effect.asSome(use) : Effect.succeed(Option.none<A>()),
      (claimed) => claimed ? fs.remove(file).pipe(Effect.catchTag("PlatformError", (error) => Console.error("cannot release " + file + ": " + error.message))) : Effect.void
    )
  })
