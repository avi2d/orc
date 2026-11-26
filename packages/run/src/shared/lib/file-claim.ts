import { dlopen, FFIType, read } from "bun:ffi"
import { hostname } from "node:os"
import { Clock, Console, Effect, FileSystem, Option, PlatformError, Predicate, Schema } from "effect"

// A launcher install clones and installs a release under its claim, so the bound leaves it room to finish.
const claimLifetimeMillis = 60 * 60 * 1000

const ClaimJson = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, at: Schema.Finite, token: Schema.String }))

const decodeClaim = Schema.decodeUnknownOption(ClaimJson)

const encodeClaim = (claim: typeof ClaimJson.Type): string => JSON.stringify(claim)

export const isRunning = (pid: number): Effect.Effect<boolean> =>
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

const readClaim = (fs: FileSystem.FileSystem, file: string): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> =>
  fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone)
  )

// link(2) publishes the claim whole, so no reader takes a claim mid-write for an abandoned one.
const publishClaim = (fs: FileSystem.FileSystem, file: string, mine: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
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

const dropClaim = (fs: FileSystem.FileSystem, file: string, held: string): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.flatMap(readClaim(fs, file), (current) => Option.contains(current, held) ? fs.remove(file) : Effect.void)

const libcPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
const libc = dlopen(libcPath, {
  open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
})
const errnoName = process.platform === "darwin" ? "__error" : "__errno_location"
const errno = dlopen(libcPath, { [errnoName]: { args: [], returns: FFIType.ptr } }).symbols[errnoName]
const processStartedAt = Date.now() - process.uptime() * 1000

const lockFailure = (file: string, method: string, cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method, pathOrDescriptor: file, cause })

const withKernelLock = <A, E, R>(file: string, use: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E | PlatformError.PlatformError, R | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.acquireUseRelease(
      Effect.flatMap(Effect.sync(() => libc.symbols.open(Buffer.from(file + "\0"), 2 | (process.platform === "darwin" ? 0x1000200 : 0x80040), 0o600)), (fd) =>
        fd < 0 ? Effect.fail(lockFailure(file, "open", "cannot open lock file")) : Effect.succeed(fd)),
      (fd) => Effect.gen(function*() {
        const code = yield* Effect.sync(() => {
          if (libc.symbols.flock(fd, 2 | 4) === 0) return 0
          const address = errno()
          return address === null ? -1 : read.i32(address)
        })
        if (code === (process.platform === "darwin" ? 35 : 11)) return Option.none<A>()
        if (code !== 0) return yield* Effect.fail(lockFailure(file, "flock", "errno " + code))
        yield* fs.writeFileString(file, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: processStartedAt }))
        return yield* Effect.asSome(use)
      }),
      (fd) => Effect.sync(() => { libc.symbols.close(fd) })
    )
  })

const takeClaim = (fs: FileSystem.FileSystem, file: string, mine: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
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

export const withFileClaim = <A, E, R>(file: string, use: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E | PlatformError.PlatformError, R | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const mine = encodeClaim({ pid: process.pid, at: yield* Clock.currentTimeMillis, token: crypto.randomUUID() })
    const result = yield* withKernelLock(file + ".guard", Effect.acquireUseRelease(
      takeClaim(fs, file, mine),
      (claimed) => claimed ? Effect.asSome(use) : Effect.succeed(Option.none<A>()),
      (claimed) => claimed
        ? dropClaim(fs, file, mine).pipe(Effect.catchTag("PlatformError", (error) => Console.error("cannot release " + file + ": " + error.message)))
        : Effect.void
    ))
    return Option.flatten(result)
  })
