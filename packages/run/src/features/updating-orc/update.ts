import { Effect, type FileSystem, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { readOrcConfig } from "../../shared/config/index"
import { capture, type Command } from "../../shared/process/index"

const packageName = "@avi2dg/orc"

const defaultRegistry = "https://registry.npmjs.org"

const registryTimeoutMs = 15_000

const UPDATE_JSON_SCHEMA = "orc.update.v1" as const

const UpdateJsonSchema = Schema.Struct({
  schema: Schema.Literal(UPDATE_JSON_SCHEMA),
  found: Schema.NullOr(Schema.String),
  running: Schema.String,
  outcome: Schema.Literals(["installed", "current", "failed"]),
  detail: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.String)
})

export type UpdateDocument = typeof UpdateJsonSchema.Type

const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/))

const LatestManifest = Schema.Struct({ version: Version })

export const isNewer = (found: string, running: string): boolean => Bun.semver.order(found, running) === 1

export const installCommand = (configured: Command | undefined, version: string): Command => {
  if (configured === undefined) {
    return ["bun", "add", "-g", packageName + "@" + version]
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

const document = (running: string, found: string | null, outcome: UpdateDocument["outcome"], detail: string | null, output: string | null): UpdateDocument =>
  ({ schema: UPDATE_JSON_SCHEMA, found, running, outcome, detail, output })

export interface UpdateInputs {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly running: string
}

export const runUpdate = (inputs: UpdateInputs): Effect.Effect<UpdateDocument, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(inputs.home).pipe(Effect.mapError((error) => error.file + ": " + error.detail))
    const found = yield* readLatest(registryOf(inputs.env))
    if (!isNewer(found, inputs.running)) {
      return document(inputs.running, found, "current", null, null)
    }
    const command = installCommand(config.update?.command, found)
    return yield* capture(command, null).pipe(
      Effect.map((result) => {
        const output = (result.stdout + result.stderr).trim()
        return result.exitCode === 0
          ? document(inputs.running, found, "installed", null, output)
          : document(inputs.running, found, "failed", command.join(" ") + " exited " + String(result.exitCode), output)
      }),
      Effect.catchTag("RunnerError", (error) => Effect.succeed(document(inputs.running, found, "failed", error.detail, null)))
    )
  }).pipe(
    Effect.catch((detail) => Effect.succeed(document(inputs.running, null, "failed", detail, null)))
  )

export const encodeUpdateJson = (update: UpdateDocument): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(UpdateJsonSchema)(update).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const formatUpdate = (update: UpdateDocument): string => {
  switch (update.outcome) {
    case "installed": {
      return "orc update installed " + packageName + " " + String(update.found) + " over " + update.running
    }
    case "current": {
      return "orc " + update.running + " is current, the registry's newest is " + String(update.found)
    }
    case "failed": {
      const reason = "orc update stayed on " + update.running + ": " + String(update.detail)
      return update.output === null || update.output === "" ? reason : reason + "\n" + update.output
    }
  }
}
