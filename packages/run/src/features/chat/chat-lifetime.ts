import { Effect, Equal, FileSystem } from "effect"

const sameFile = (a: FileSystem.File.Info, b: FileSystem.File.Info): boolean => a.dev === b.dev && Equal.equals(a.ino, b.ino)

export const whileSessionExists = Effect.fnUntraced(function*<E, R>(
  pi: Effect.Effect<number, E, R>,
  session: string | null,
  drawerLease: string | null
) {
  if (session === null) return yield* pi
  const fs = yield* FileSystem.FileSystem
  const stat = (path: string) => fs.stat(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
  const current = stat(session)
  let original = yield* current
  const lease = drawerLease === null ? null : stat(drawerLease)
  if (lease !== null) {
    const owner = yield* lease
    if (owner === null || original === null || !sameFile(owner, original)) return 0
  }
  const untilRemoved = Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep("1 second")
      const present = yield* current
      if (original !== null && (present === null || !sameFile(original, present))) return 0
      if (lease !== null && (yield* lease) === null) return 0
      original ??= present
    }
  })
  return yield* Effect.raceFirst(pi, untilRemoved)
})
