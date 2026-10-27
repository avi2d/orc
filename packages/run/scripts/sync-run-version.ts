import { Data, Effect, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"

export class SyncRunVersionError extends Data.TaggedError("SyncRunVersionError")<{
  readonly message: string
}> {}

const fail = (message: string): Effect.Effect<never, SyncRunVersionError> =>
  Effect.fail(new SyncRunVersionError({ message }))

const quote = String.fromCharCode(34)

interface VersionBounds {
  readonly end: number
  readonly start: number
}

const versionOf = (text: string): Effect.Effect<string, SyncRunVersionError> =>
  Effect.gen(function*() {
    const data: unknown = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new SyncRunVersionError({ message: "manifest holds no version" })
    })
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return yield* fail("manifest holds no version")
    }
    const version = (data as { readonly version?: unknown }).version
    if (typeof version !== "string") {
      return yield* fail("manifest holds no version")
    }
    return version
  })

const versionBounds = (text: string, searchFrom: number): Effect.Effect<VersionBounds, SyncRunVersionError> =>
  Effect.gen(function*() {
    const key = quote + "version" + quote
    const keyAt = text.indexOf(key, searchFrom)
    if (keyAt === -1) {
      return yield* fail("version field holds no value")
    }
    const colonAt = text.indexOf(":", keyAt + key.length)
    if (colonAt === -1) {
      return yield* fail("version field holds no value")
    }
    const openAt = text.indexOf(quote, colonAt)
    if (openAt === -1) {
      return yield* fail("version field holds no value")
    }
    const start = openAt + 1
    const end = text.indexOf(quote, start)
    if (end === -1) {
      return yield* fail("version field holds no value")
    }
    return { end, start }
  })

const readText = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string, SyncRunVersionError> =>
  fs.readFileString(path).pipe(
    Effect.mapError((cause) => new SyncRunVersionError({ message: "cannot read " + path + ": " + String(cause) }))
  )

const writeText = (
  fs: FileSystem.FileSystem,
  path: string,
  text: string
): Effect.Effect<void, SyncRunVersionError> =>
  fs.writeFileString(path, text).pipe(
    Effect.mapError((cause) => new SyncRunVersionError({ message: "cannot write " + path + ": " + String(cause) }))
  )

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const rootText = yield* readText(fs, "package.json")
  const runText = yield* readText(fs, "packages/run/package.json")
  const lockText = yield* readText(fs, "bun.lock")
  const rootVersion = yield* versionOf(rootText)
  const runBounds = yield* versionBounds(runText, 0)
  const runVersion = runText.slice(runBounds.start, runBounds.end)
  if (runVersion !== rootVersion) {
    yield* writeText(fs, "packages/run/package.json", runText.slice(0, runBounds.start) + rootVersion + runText.slice(runBounds.end))
  }
  const lockSearch = lockText.indexOf("packages/run")
  if (lockSearch === -1) {
    return yield* fail("lockfile holds no run package")
  }
  const lockBounds = yield* versionBounds(lockText, lockSearch)
  const lockVersion = lockText.slice(lockBounds.start, lockBounds.end)
  if (lockVersion !== rootVersion) {
    yield* writeText(fs, "bun.lock", lockText.slice(0, lockBounds.start) + rootVersion + lockText.slice(lockBounds.end))
  }
}).pipe(Effect.provide(BunServices.layer))

void Effect.runPromise(program)
