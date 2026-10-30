import { Effect, Option, Result, Schema, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { inheritedEnv } from "./nono"
import type { CheckedModelWindow, HostTools } from "./nono-profile"
import { OrcRunError } from "./run-session"

const contextMarkTokens = 150_000

export type ModelProbe =
  | { readonly kind: "operator" }
  | { readonly kind: "agent-dir"; readonly agentDir: string; readonly packages: boolean }

const probeFlags = "--mode rpc --no-session --no-skills --no-context-files"

// Pi lists a package's models only with its extensions loaded, and installs a missing package only online.
const sealedProbeFlags = probeFlags + " --no-extensions --offline"

export const modelListCommand = (host: HostTools, probe: ModelProbe = { kind: "operator" }): ReadonlyArray<string> => {
  const flags = probe.kind === "agent-dir" && probe.packages ? probeFlags : sealedProbeFlags
  const prefix = "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" "
  return [
    "/bin/sh",
    "-c",
    probe.kind === "operator" ? prefix + "unset PI_CODING_AGENT_DIR; exec \"$1\" " + flags : prefix + "exec \"$1\" " + flags,
    host.nodeBinary,
    host.piBinary,
    host.homeDir
  ]
}

export const modelListRequest = JSON.stringify({ id: "orc-models", type: "get_available_models" }) + "\n"

const ListedModel = Schema.Struct({ provider: Schema.String, id: Schema.String, contextWindow: Schema.Int })

const ModelListReply = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("get_available_models"),
  success: Schema.Literal(true),
  data: Schema.Struct({ models: Schema.Array(ListedModel) })
})

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ModelListReply))

export type ModelWindows = ReadonlyMap<string, number>

export const parseModelWindows = (stdout: string): Option.Option<ModelWindows> =>
  Option.map(
    Option.firstSomeOf(stdout.split("\n").map((line) => decodeReply(line))),
    (reply) => new Map(reply.data.models.map((model) => [model.provider + "/" + model.id, model.contextWindow]))
  )

export const readModelWindows = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  cwd: string,
  probe: ModelProbe,
  extraEnv: Readonly<Record<string, string>> = {}
): Effect.Effect<ModelWindows, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const parts = modelListCommand(host, probe)
    const handle = yield* spawner.spawn(ChildProcess.make(parts[0], parts.slice(1), {
      cwd,
      env: probe.kind === "operator" ? { ...inheritedEnv(Bun.env), ...extraEnv } : { ...inheritedEnv(Bun.env), ...extraEnv, PI_CODING_AGENT_DIR: probe.agentDir },
      extendEnv: false,
      stdin: Stream.fromIterable([new TextEncoder().encode(modelListRequest)])
    }))
    const [stdout, stderr] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    const windows = parseModelWindows(stdout)
    if (Option.isNone(windows)) {
      return yield* new OrcRunError({ message: "orc: pi listed no models, so orc cannot place the context mark: " + stderr.trim() })
    }
    return windows.value
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: the model list failed to run: " + String(cause) }))
  )

export const checkedModelWindows = (
  models: ReadonlyArray<string>,
  windows: ModelWindows
): Result.Result<ReadonlyArray<CheckedModelWindow>, string> => {
  const checked: Array<CheckedModelWindow> = []
  for (const model of new Set(models)) {
    const slash = model.indexOf("/")
    const window = slash === -1 ? undefined : windows.get(model)
    if (window === undefined) {
      return Result.fail("orc: pi lists no model " + model + ", so orc cannot place the " + contextMarkTokens + " token context mark")
    }
    if (window <= contextMarkTokens) {
      return Result.fail("orc: model " + model + " holds " + window + " tokens, which does not reach the " + contextMarkTokens + " token context mark")
    }
    checked.push({ ref: model, provider: model.slice(0, slash), id: model.slice(slash + 1), window })
  }
  return Result.succeed(checked)
}

// Pi takes no absolute compaction point, only a reserve below each model's window.
export const contextMarkJson = (checked: ReadonlyArray<CheckedModelWindow>, packages: ReadonlyArray<string> = []): string => {
  const modelOverrides: Record<string, { readonly reserveTokens: number }> = {}
  for (const entry of checked) {
    modelOverrides[entry.ref] = { reserveTokens: entry.window - contextMarkTokens }
  }
  return JSON.stringify({ ...(packages.length === 0 ? {} : { packages }), compaction: { modelOverrides } }, null, 2) + "\n"
}
