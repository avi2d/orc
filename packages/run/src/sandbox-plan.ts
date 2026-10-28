import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { SandboxKind } from "./args"
import { checkedModelWindows, contextMarkJson, readModelWindows } from "./context-mark"
import { claudeApiKey, claudeProvider, claudeTokenFileVar, type ModelRoute, requireClaudeTokenFile } from "./model-route"
import { inheritedEnv } from "./nono"
import { type CheckedModelWindow, type HostTools, loginCheckCommand, type ModelCredential, modelCredentialFor, piAgentModels, type ProviderKey, providerKeyOf } from "./nono-profile"
import { OrcRunError } from "./run-session"

export type SandboxPlan =
  | { readonly kind: "nono"; readonly credential: ModelCredential }
  | { readonly kind: "none"; readonly piAgentDir: string | undefined }

interface PlanDirs {
  readonly projectDir: string
  readonly runDir: string
  readonly piAgentDir: string
}

interface AgentModels {
  readonly agent: string
  readonly fixer: string
}

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

const runLoginCheck = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  cwd: string,
  preserveAgentDir: boolean
): Effect.Effect<void, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const parts = loginCheckCommand(host, preserveAgentDir)
    const agentDir = Bun.env.PI_CODING_AGENT_DIR === undefined ? {} : { PI_CODING_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR }
    const handle = yield* spawner.spawn(ChildProcess.make(parts[0], parts.slice(1), { cwd, env: preserveAgentDir ? { ...inheritedEnv(Bun.env), ...agentDir } : inheritedEnv(Bun.env), extendEnv: false }))
    const [, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.runDrain),
      handle.stderr.pipe(Stream.decodeText(), Stream.runDrain),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return yield* refuse("orc: pi auth check found no opencode-go login, so a key held only in the keychain or in an environment variable is refused; add an opencode-go login to pi on the host and rerun")
    }
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: the login check failed to run: " + String(cause) }))
  )

const writeAgentDir = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  piAgentDir: string,
  key: ProviderKey,
  checked: ReadonlyArray<CheckedModelWindow>
): Effect.Effect<void, OrcRunError> =>
  fs.writeFileString(path.join(piAgentDir, "models.json"), piAgentModels(key, checked)).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent models file: " + String(cause) })),
    Effect.andThen(() => fs.writeFileString(path.join(piAgentDir, "settings.json"), contextMarkJson(checked)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent settings file: " + String(cause) }))
    ))
  )

const checkedAgentWindows = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  runDir: string,
  models: AgentModels,
  agentDir: string | undefined
): Effect.Effect<ReadonlyArray<CheckedModelWindow>, OrcRunError> =>
  readModelWindows(spawner, host, runDir, agentDir).pipe(
    Effect.flatMap((windows) => Effect.fromResult(checkedModelWindows([models.agent, models.fixer], windows)).pipe(
      Effect.mapError((message) => new OrcRunError({ message }))
    ))
  )

const planOpencodeGo = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> =>
  Effect.gen(function*() {
    const credential = modelCredentialFor(models.agent, host)
    if (credential === null) {
      return yield* refuse("orc: the agent file names model " + models.agent + ", which names no opencode-go credential")
    }
    const preserveAgentDir = sandboxKind === "none"
    yield* runLoginCheck(spawner, host, dirs.projectDir, preserveAgentDir)
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, preserveAgentDir ? Bun.env.PI_CODING_AGENT_DIR : undefined)
    if (sandboxKind === "none") {
      return { kind: "none", piAgentDir: undefined }
    }
    yield* writeAgentDir(fs, path, dirs.piAgentDir, providerKeyOf(credential), checked)
    return { kind: "nono", credential }
  })

// Pi prefers a stored login over a configured key, so a Claude run reads its own agent folder and never the operator's.
const planClaude = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> =>
  Effect.gen(function*() {
    if (sandboxKind === "nono") {
      return yield* refuse("orc: the agent file names model " + models.agent + ", and the nono sandbox carries only the opencode-go key, so run a Claude model with --sandbox none")
    }
    yield* requireClaudeTokenFile(fs, models.agent, Bun.env[claudeTokenFileVar])
    const key: ProviderKey = { provider: claudeProvider, apiKey: claudeApiKey }
    // Pi lists no model of a provider that has no key, so the key goes in before the windows are read.
    yield* writeAgentDir(fs, path, dirs.piAgentDir, key, [])
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, dirs.piAgentDir)
    yield* writeAgentDir(fs, path, dirs.piAgentDir, key, checked)
    return { kind: "none", piAgentDir: dirs.piAgentDir }
  })

export const planSandbox = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  route: ModelRoute,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> =>
  route === "claude"
    ? planClaude(fs, path, spawner, host, dirs, models, sandboxKind)
    : planOpencodeGo(fs, path, spawner, host, dirs, models, sandboxKind)
