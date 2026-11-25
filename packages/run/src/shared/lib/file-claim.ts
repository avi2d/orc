import { Clock, Console, Effect, FileSystem, Option, Predicate, Schema } from "effect"

import type { PlatformError } from "effect/PlatformError"

// A launcher install clones and installs a release under its claim, so the bound leaves it room to finish.
const claimLifetimeMillis = 60 * 60 * 1000

const ClaimJson = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, at: Schema.Finite, token: Schema.String }))

const decodeClaim = Schema.decodeUnknownOption(ClaimJson)

const encodeClaim = (claim: typeof ClaimJson.Type): string => JSON.stringify(claim)

const isRunning = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) => Predicate.hasProperty(error, "code") && error.code === "EPERM"
  }).pipe(
    Effect.as(true),
    Effect.catch((ownedByAnotherUser) => Effect.succeed(ownedByAnotherUser))
  )

const isAbandoned = (held: string): Effect.Effect<boolean> =>
  Option.match(decodeClaim(held), {
    onNone: () => Effect.succeed(true),
    onSome: ({ pid, at }) => Effect.flatMap(Clock.currentTimeMillis, (now) =>
      now - at > claimLifetimeMillis ? Effect.succeed(true) : Effect.map(isRunning(pid), (running) => !running))
  })

const readClaim = (fs: FileSystem.FileSystem, file: string): Effect.Effect<Option.Option<string>, PlatformError> =>
  fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone)
  )

const createExclusive = (fs: FileSystem.FileSystem, file: string, text: string): Effect.Effect<boolean, PlatformError> =>
  fs.writeFileString(file, text, { flag: "wx" }).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false))
  )

// link(2) publishes the claim whole, so no reader takes a claim mid-write for an abandoned one.
const publishClaim = (fs: FileSystem.FileSystem, file: string, mine: string): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function*() {
    const scratch = file + "." + crypto.randomUUID() + ".tmp"
    yield* fs.writeFileString(scratch, mine)
    const published = yield* fs.link(scratch, file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false))
    )
    yield* fs.remove(scratch)
    return published
  })

const breakerOf = (file: string, held: string): string =>
  file + "." + new Bun.CryptoHasher("sha256").update(held).digest("hex").slice(0, 16) + ".break"

// Every removal of a claim holds the breaker named after that claim, so no one removes a claim published after the one they read.
const dropClaim = (fs: FileSystem.FileSystem, file: string, held: string): Effect.Effect<void, PlatformError> => {
  const breaker = breakerOf(file, held)
  return Effect.acquireUseRelease(
    createExclusive(fs, breaker, ""),
    (owned) => owned
      ? Effect.flatMap(readClaim(fs, file), (current) => Option.contains(current, held) ? fs.remove(file) : Effect.void)
      : Effect.void,
    (owned) => owned ? fs.remove(breaker, { force: true }) : Effect.void
  )
}

const takeClaim = (fs: FileSystem.FileSystem, file: string, mine: string): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function*() {
    if (yield* publishClaim(fs, file, mine)) {
      return true
    }
    const held = yield* readClaim(fs, file)
    if (Option.isSome(held)) {
      if (!(yield* isAbandoned(held.value))) {
        return false
      }
      yield* dropClaim(fs, file, held.value)
    }
    return yield* publishClaim(fs, file, mine)
  })

export const withFileClaim = <A, E, R>(file: string, use: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E | PlatformError, R | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const mine = encodeClaim({ pid: process.pid, at: yield* Clock.currentTimeMillis, token: crypto.randomUUID() })
    return yield* Effect.acquireUseRelease(
      takeClaim(fs, file, mine),
      (claimed) => claimed ? Effect.asSome(use) : Effect.succeed(Option.none<A>()),
      (claimed) => claimed
        ? dropClaim(fs, file, mine).pipe(Effect.catchTag("PlatformError", (error) => Console.error("cannot release " + file + ": " + error.message)))
        : Effect.void
    )
  })
