import { homedir } from "node:os"
import { Effect, type FileSystem, type Path, Result, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { UPDATE_JSON_SCHEMA, UpdateJson, installerError, isNewer, type UpdateDocument } from "../../entities/orc-update/index"
import { readOrcConfig } from "../../shared/config/index"
import { capture, selfCommand, type Command } from "../../shared/process/index"
import { installLauncherRelease, launcherDirectory, type LauncherBuild } from "./launcher-release"

const packageName = "@avi2dg/orc"

const defaultRegistry = "https://registry.npmjs.org"

const registryTimeoutMs = 15_000

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/))

const LatestManifest = Schema.Struct({ version: Version })

export const installCommand = (configured: Command | undefined, version: string, npmPrefix?: string): Command => {
  if (configured === undefined) {
    const release = packageName + "@" + version
    return npmPrefix
      ? ["npm", "install", "-g", "--prefix", npmPrefix, release]
      : ["bun", "add", "-g", release]
  }
  const [program, ...args] = configured
  return [program, ...args.map((arg) => arg.replaceAll("{version}", version))]
}

export const registryOf = (env: Readonly<Record<string, string | undefined>>): string =>
  (env.npm_config_registry ?? defaultRegistry).replace(/\/+$/, "")

const readFailure = (url: string, cause: unknown): string =>
  cause instanceof Error && cause.name === "TimeoutError"
    ? url + " gave no answer within " + String(registryTimeoutMs / 1000) + " seconds"
    : "reading " + url + " failed: " + (cause instanceof Error ? cause.message : String(cause))

const readLatest = (registry: string): Effect.Effect<string, string> => {
  const url = registry + "/" + packageName + "/latest"
  return Effect.tryPromise({
    try: (signal) => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(registryTimeoutMs)]) }),
    catch: (cause) => readFailure(url, cause)
  }).pipe(
    Effect.flatMap((response) => response.ok
      ? Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: (cause) => readFailure(url, cause) })
      : Effect.fail(url + " answered " + String(response.status))),
    Effect.flatMap((body) => Schema.decodeUnknownEffect(LatestManifest)(body).pipe(
      Effect.mapError(() => url + " answered with no version orc can read")
    )),
    Effect.map((manifest) => manifest.version)
  )
}

const current = (running: string, found: string): UpdateDocument =>
  ({ schema: UPDATE_JSON_SCHEMA, found, running, outcome: "current", detail: null, output: null })

const installed = (running: string, found: string, output: string | null): UpdateDocument =>
  ({ schema: UPDATE_JSON_SCHEMA, found, running, outcome: "installed", detail: null, output })

const failed = (running: string, found: string | null, detail: string, output: string | null, retryable?: false): UpdateDocument =>
  ({ schema: UPDATE_JSON_SCHEMA, found, running, outcome: "failed", detail, output, ...(retryable === false ? { retryable } : {}) })

export interface UpdateInputs {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly running: string
  readonly main: string
  readonly executable: string
  readonly releases: string
}

export const runUpdate = (inputs: UpdateInputs): Effect.Effect<UpdateDocument, never, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const { running, env, main, executable } = inputs
    const config = yield* readOrcConfig(inputs.home).pipe(Effect.result)
    if (Result.isFailure(config)) {
      const error = config.failure
      return failed(running, null, error.file + ": " + error.detail, null, false)
    }
    const latest = yield* readLatest(registryOf(env)).pipe(Effect.result)
    if (Result.isFailure(latest)) {
      return failed(running, null, latest.failure, null)
    }
    const found = latest.success
    if (!isNewer(found, running)) {
      return current(running, found)
    }
    const configured = config.success.update?.command
    if (configured === undefined) {
      const compiled = selfCommand(executable, main).length === 1
      const directory = yield* launcherDirectory(env.HOME || homedir(), compiled ? executable : main, running, compiled)
      if (directory !== null) {
        const build: LauncherBuild = compiled
          ? { kind: "compiled", releases: inputs.releases, platform: process.platform + "-" + process.arch }
          : { kind: "source", bun: executable }
        return yield* installLauncherRelease(directory, found, running, build).pipe(
          Effect.map((previous) => previous === null ? current(running, found) : installed(previous, found, null)),
          Effect.catchTag("InstallFailure", (error) => Effect.succeed(failed(running, found, error.detail, error.output, error.retryable)))
        )
      }
    }
    const command = installCommand(configured, found, env.ORC_NPM_GLOBAL_PREFIX)
    return yield* capture(command, null).pipe(
      Effect.map((result) => {
        const output = (result.stdout + result.stderr).trim()
        return result.exitCode === 0
          ? installed(running, found, output)
          : failed(running, found, command.join(" ") + " exited " + String(result.exitCode), output)
      }),
      Effect.catchTag("RunnerError", (error) => Effect.succeed(failed(running, found, error.detail, null)))
    )
  })

export const encodeUpdateJson = Schema.encodeEffect(UpdateJson)

export const formatUpdate = (update: UpdateDocument): string => {
  switch (update.outcome) {
    case "installed": {
      return "orc update installed " + packageName + " " + update.found + " over " + update.running
    }
    case "current": {
      return "orc " + update.running + " is current, the registry's newest is " + update.found
    }
    case "failed": {
      return "orc update stayed on " + update.running + ": " + installerError(update)
    }
  }
}
