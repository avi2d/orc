import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import packageJson from "../../../package.json" with { type: "json" }
import { isNewer, stableVersion } from "../../entities/orc-update/index"
import { withFileClaim } from "../../shared/lib/index"
import { capture, type Command } from "../../shared/process/index"

class InstallFailure extends Schema.TaggedError<InstallFailure>()("InstallFailure", {
  detail: Schema.String,
  output: Schema.NullOr(Schema.String),
  retryable: Schema.optionalKey(Schema.Literal(false))
}) {}

const sourceEntry = (path: Path.Path, checkout: string): string => path.join(checkout, "packages", "run", "src", "bin.ts")

const releaseOf = (path: Path.Path, directory: string, version: string): string => path.join(directory, "v" + version)

export const launcherDirectory = Effect.fnUntraced(function*(userHome: string, entryPoint: string, running: string, compiled: boolean) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(userHome, ".local", "share", "orc")
  const release = releaseOf(path, directory, running)
  const entry = yield* fs.realPath(compiled ? path.join(release, "orc") : sourceEntry(path, release)).pipe(Effect.option)
  const actual = yield* fs.realPath(entryPoint).pipe(Effect.option)
  return Option.isSome(actual) && Option.contains(entry, actual.value) ? directory : null
})

const runInstallerStep = (command: Command, action: string) => capture(command, null).pipe(
  Effect.mapError((error) => new InstallFailure({ detail: action + ": " + error.detail, output: null })),
  Effect.flatMap(({ exitCode, stdout, stderr }) => exitCode === 0
    ? Effect.succeed(stdout.trim())
    : Effect.fail(new InstallFailure({ detail: action + " exited " + String(exitCode), output: (stdout + stderr).trim() })))
)

const checkRelease = (command: Command, version: string) =>
  runInstallerStep([...command, "--version"], "verify launcher release " + version).pipe(
    Effect.flatMap((reported) => reported === "orc " + version
      ? Effect.void
      : Effect.fail(new InstallFailure({ detail: "launcher release " + version + " reported the wrong version", output: reported, retryable: false })))
  )

const removeTemporary = (fs: FileSystem.FileSystem, path: string, recursive = false) =>
  fs.remove(path, { recursive, force: true }).pipe(
    Effect.catchTag("PlatformError", (error) => Console.error("cannot remove " + path + ": " + error.message))
  )

const prepareRelease = Effect.fnUntraced(function*(directory: string, version: string, bun: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const checkout = releaseOf(path, directory, version)
  const entry = sourceEntry(path, checkout)
  const binary = path.join(checkout, "orc")
  const checkExisting = fs.exists(binary).pipe(
    Effect.flatMap((exists) => checkRelease(exists ? [binary] : [bun, entry], version))
  )
  if (yield* fs.exists(checkout)) {
    yield* checkExisting
    return
  }
  yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({ directory, prefix: ".v" + version + "." }),
    (staging) => Effect.gen(function*() {
      yield* runInstallerStep(
        ["git", "clone", "--quiet", "--depth", "1", "--branch", "v" + version, packageJson.repository.url.replace(/^git\+/, ""), staging],
        "clone launcher release " + version
      )
      yield* runInstallerStep([bun, "install", "--cwd", staging, "--frozen-lockfile", "--production", "--ignore-scripts", "--silent"], "install launcher release " + version)
      yield* checkRelease([bun, sourceEntry(path, staging)], version)
      yield* fs.rename(staging, checkout).pipe(
        Effect.catch((error) => fs.exists(checkout).pipe(
          Effect.flatMap((exists) => exists
            ? checkExisting
            : Effect.fail(new InstallFailure({ detail: "cannot publish launcher release " + version + ": " + error.message, output: null })))
        ))
      )
    }),
    (staging) => removeTemporary(fs, staging, true)
  )
})

const selectRelease = Effect.fnUntraced(function*(directory: string, version: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(directory, "release")
  const next = path.join(directory, ".release." + crypto.randomUUID())
  yield* Effect.acquireUseRelease(
    fs.writeFileString(next, version + "\n", { flag: "wx" }),
    () => fs.rename(next, file),
    () => removeTemporary(fs, next)
  )
})

export const installLauncherRelease = Effect.fnUntraced(function*(directory: string, version: string, running: string, bun: string) {
  if (!stableVersion.test(version)) {
    return yield* new InstallFailure({ detail: "the launcher only accepts versions of the form X.Y.Z", output: null, retryable: false })
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const install = Effect.gen(function*() {
    const selected = (yield* fs.readFileString(path.join(directory, "release")).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(""))
    )).trim()
    const previous = stableVersion.test(selected) && isNewer(selected, running) ? selected : running
    if (!isNewer(version, previous)) {
      return null
    }
    yield* prepareRelease(directory, version, bun)
    yield* selectRelease(directory, version)
    return previous
  })
  const result = yield* withFileClaim(path.join(directory, ".update.lock"), install).pipe(
    Effect.catchTag("PlatformError", (error) => Effect.fail(new InstallFailure({ detail: "cannot prepare or select launcher release " + version + ": " + error.message, output: null })))
  )
  if (Option.isNone(result)) {
    return yield* new InstallFailure({ detail: "a launcher update holds the release lock", output: null })
  }
  return result.value
})
