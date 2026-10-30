import { Console, DateTime, Duration, Effect, FileSystem, Option, type PlatformError, Redacted } from "effect"
import type { RunToken } from "./token"

export const heldTokenDir = (home: string, task: string): string => home + "/runner/tokens/" + task

export const heldTokenFile = (dir: string): string => dir + "/token"

const expiryFile = (dir: string): string => dir + "/expires-at"

const ownerOnlyDir = 0o700

const ownerOnlyFile = 0o600

const lockFor = (dir: string): string => dir + ".lock"

const tempFor = (file: string): string => file + "." + process.pid + "." + crypto.randomUUID().slice(0, 8) + ".next"

// A reader sees the old file or the new one whole, never a token cut mid-write.
const replaceFile = (fs: FileSystem.FileSystem, file: string, text: string) => {
  const next = tempFor(file)
  return fs.remove(next, { force: true }).pipe(
    Effect.andThen(fs.writeFileString(next, text, { flag: "wx", mode: ownerOnlyFile })),
    Effect.andThen(fs.rename(next, file))
  )
}

const acquireLock = (fs: FileSystem.FileSystem, lock: string) =>
  Effect.gen(function*() {
    let waits = 0
    while (true) {
      const taken = yield* fs.makeDirectory(lock).pipe(Effect.as(true), Effect.orElseSucceed(() => false as const))
      if (taken) {
        return
      }
      waits += 1
      if (waits % 250 === 0) {
        yield* fs.remove(lock, { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined as void))
      }
      yield* Effect.sleep(Duration.millis(20))
    }
  })

const withTaskLock = <A, E>(fs: FileSystem.FileSystem, dir: string, use: Effect.Effect<A, E, never>): Effect.Effect<A, E | PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.acquireUseRelease(
    acquireLock(fs, lockFor(dir)),
    () => use,
    () => fs.remove(lockFor(dir), { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined as void))
  )

const makeOwnerOnlyDir = (fs: FileSystem.FileSystem, dir: string) =>
  fs.makeDirectory(dir, { recursive: true, mode: ownerOnlyDir }).pipe(Effect.andThen(fs.chmod(dir, ownerOnlyDir)))

// The token goes in before its expiry, so an expiry read as live never names a token older than itself.
const writePair = (fs: FileSystem.FileSystem, dir: string, token: RunToken) =>
  replaceFile(fs, heldTokenFile(dir), Redacted.value(token.token)).pipe(
    Effect.andThen(replaceFile(fs, expiryFile(dir), DateTime.formatIso(token.expiresAt)))
  )

const writeToken = (fs: FileSystem.FileSystem, dir: string, token: RunToken) =>
  withTaskLock(fs, dir, writePair(fs, dir, token))

export const holdToken = (home: string, task: string, token: RunToken): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = heldTokenDir(home, task)
    yield* makeOwnerOnlyDir(fs, home + "/runner/tokens")
    yield* makeOwnerOnlyDir(fs, dir)
    yield* writeToken(fs, dir, token)
    return dir
  })

// Only a run still holding its folder takes a fresh token, so a renewal never brings back the folder of a run that ended.
export const replaceHeldToken = (home: string, task: string, token: RunToken): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = heldTokenDir(home, task)
    return yield* withTaskLock(fs, dir, Effect.gen(function*() {
      if (!(yield* fs.exists(dir))) {
        return false
      }
      yield* writePair(fs, dir, token)
      return true
    }))
  })

export const heldExpiry = (home: string, task: string): Effect.Effect<Option.Option<DateTime.Utc>, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(expiryFile(heldTokenDir(home, task))).pipe(Effect.option)
    return Option.flatMap(text, (iso) => DateTime.make(iso.trim())).pipe(Option.map(DateTime.toUtc))
  })

export const dropHeldToken = (home: string, task: string): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(heldTokenDir(home, task), { recursive: true, force: true })
  })

// Cleanup runs after the outcome is settled, so a folder that will not go is reported rather than put in the outcome's place.
export const releaseHeldToken = (home: string, task: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  dropHeldToken(home, task).pipe(
    Effect.catchTag("PlatformError", (error) => Console.error("orc: cannot remove the token folder " + heldTokenDir(home, task) + ": " + error.message))
  )
