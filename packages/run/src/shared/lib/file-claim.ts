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

const loadLibc = () => {
  const libcPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
  const libc = dlopen(libcPath, {
    open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
  })
  const errnoName = process.platform === "darwin" ? "__error" : "__errno_location"
  const errno = dlopen(libcPath, { [errnoName]: { args: [], returns: FFIType.ptr } }).symbols[errnoName]
  return { libc, errno }
}

let loadedLibc: ReturnType<typeof loadLibc> | undefined

const loadKernel32 = () => dlopen("kernel32.dll", {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
  LockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  UnlockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 }
}).symbols

let loadedKernel32: ReturnType<typeof loadKernel32> | undefined

const processStartedAt = Date.now() - process.uptime() * 1000

const lockFailure = (file: string, method: string, cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method, pathOrDescriptor: file, cause })

type Unlock = () => void

// Success holds the lock until the returned unlock runs, and none means another process holds it.
type TryLock = (file: string) => Effect.Effect<Option.Option<Unlock>, PlatformError.PlatformError>

const tryFlock: TryLock = (file) => Effect.suspend(() => {
  const { libc, errno } = loadedLibc ??= loadLibc()
  const fd = libc.symbols.open(Buffer.from(file + "\0"), 2 | (process.platform === "darwin" ? 0x1000200 : 0x80040), 0o600)
  if (fd < 0) {
    return Effect.fail(lockFailure(file, "open", "cannot open lock file"))
  }
  if (libc.symbols.flock(fd, 2 | 4) === 0) {
    return Effect.succeedSome(() => { libc.symbols.close(fd) })
  }
  const address = errno()
  const code = address === null ? -1 : read.i32(address)
  libc.symbols.close(fd)
  return code === (process.platform === "darwin" ? 35 : 11) ? Effect.succeedNone : Effect.fail(lockFailure(file, "flock", "errno " + code))
})

const invalidHandle = -1n
const errorLockViolation = 33

// Windows locks a byte range per handle, so a lock over the holder record would refuse the holder's own write of it.
const lockedRange = (): Buffer => {
  const overlapped = Buffer.alloc(32)
  overlapped.writeUInt32LE(0x4000_0000, 20)
  return overlapped
}

const tryLockFileEx: TryLock = (file) => Effect.suspend(() => {
  const kernel32 = loadedKernel32 ??= loadKernel32()
  const handle = kernel32.CreateFileW(Buffer.from(file + "\0", "utf16le"), 0xC000_0000, 7, null, 4, 0x80, null)
  if (handle === invalidHandle) {
    return Effect.fail(lockFailure(file, "CreateFileW", "error " + kernel32.GetLastError()))
  }
  const range = lockedRange()
  if (kernel32.LockFileEx(handle, 2 | 1, 0, 1, 0, range) !== 0) {
    return Effect.succeedSome(() => {
      kernel32.UnlockFileEx(handle, 0, 1, 0, range)
      kernel32.CloseHandle(handle)
    })
  }
  const code = kernel32.GetLastError()
  kernel32.CloseHandle(handle)
  return code === errorLockViolation ? Effect.succeedNone : Effect.fail(lockFailure(file, "LockFileEx", "error " + code))
})

const withKernelLock = <A, E, R>(file: string, use: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E | PlatformError.PlatformError, R | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tryLock = process.platform === "win32" ? tryLockFileEx : tryFlock
    return yield* Effect.acquireUseRelease(
      tryLock(file),
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: () => fs.writeFileString(file, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: processStartedAt })).pipe(
          Effect.andThen(Effect.asSome(use))
        )
      }),
      (held) => Effect.sync(() => { if (Option.isSome(held)) held.value() })
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
