import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { SandboxKind } from "./args"
import { checkedModelWindows, contextMarkJson, readModelWindows } from "./context-mark"
import { requireTokenFile, tokenFileApiKey, tokenFileSource, tokenFileVar } from "./model-route"
import { inheritedEnv } from "./nono"
import { type CheckedModelWindow, type HostTools, loginCheckCommand, type ModelCredential, modelCredentialFor, piAgentModels, type ProviderKey, providerKeyOf } from "./nono-profile"
import type { LoginProvider, OrcConfig, Provider, TokenFileProvider } from "./orc-config"
import { OrcRunError } from "./run-session"

interface OwnAgentDir {
  readonly piAgentDir: string
  readonly env: Readonly<Record<string, string>>
}

export type SandboxPlan =
  | { readonly kind: "nono"; readonly credential: ModelCredential }
  | { readonly kind: "none"; readonly own: OwnAgentDir | null }

export interface ProviderChoice<P extends Provider = Provider> {
  readonly config: OrcConfig
  readonly provider: P
  readonly tokenFileFlag: string | undefined
}

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
  providerId: string,
  preserveAgentDir: boolean
): Effect.Effect<void, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const parts = loginCheckCommand(host, providerId, preserveAgentDir)
    const agentDir = Bun.env.PI_CODING_AGENT_DIR === undefined ? {} : { PI_CODING_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR }
    const handle = yield* spawner.spawn(ChildProcess.make(parts[0], parts.slice(1), { cwd, env: preserveAgentDir ? { ...inheritedEnv(Bun.env), ...agentDir } : inheritedEnv(Bun.env), extendEnv: false }))
    const [, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.runDrain),
      handle.stderr.pipe(Stream.decodeText(), Stream.runDrain),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return yield* refuse("orc: pi auth check found no " + providerId + " login, so a key held only in the keychain or in an environment variable is refused; add a " + providerId + " login to pi on the host and rerun")
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
  agentDir: string | undefined,
  extraEnv: Readonly<Record<string, string>> = {}
): Effect.Effect<ReadonlyArray<CheckedModelWindow>, OrcRunError> =>
  readModelWindows(spawner, host, runDir, agentDir, extraEnv).pipe(
    Effect.flatMap((windows) => Effect.fromResult(checkedModelWindows([models.agent, models.fixer], windows)).pipe(
      Effect.mapError((message) => new OrcRunError({ message }))
    ))
  )

const planLogin = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  choice: ProviderChoice<LoginProvider>,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> =>
  Effect.gen(function*() {
    const provider = choice.provider
    if (choice.tokenFileFlag !== undefined) {
      return yield* refuse("orc: --token-file names a token file, and " + choice.config.file + " has the provider " + provider.id + " take a Pi login, so drop the flag or give the provider a token file")
    }
    if (sandboxKind === "none") {
      yield* runLoginCheck(spawner, host, dirs.projectDir, provider.id, true)
      yield* checkedAgentWindows(spawner, host, dirs.runDir, models, Bun.env.PI_CODING_AGENT_DIR)
      return { kind: "none", own: null }
    }
    if (provider.nono === undefined) {
      return yield* refuse("orc: " + choice.config.file + " gives the provider " + provider.id + " no nono entry, so the nono sandbox cannot carry its key; add one with its upstream or run with --sandbox none")
    }
    const credential = modelCredentialFor({ id: provider.id, upstream: provider.nono.upstream, injectHeader: provider.nono.injectHeader, credentialFormat: provider.nono.credentialFormat }, host)
    yield* runLoginCheck(spawner, host, dirs.projectDir, provider.id, false)
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, undefined)
    yield* writeAgentDir(fs, path, dirs.piAgentDir, providerKeyOf(credential), checked)
    return { kind: "nono", credential }
  })

// Pi prefers a stored login over a configured key, so a token-file run reads its own agent folder and never the operator's.
const planTokenFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  choice: ProviderChoice<TokenFileProvider>,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> =>
  Effect.gen(function*() {
    const provider = choice.provider
    if (sandboxKind === "nono") {
      return yield* refuse("orc: the implementer runs on model " + models.agent + ", whose provider " + provider.id + " takes its token from a file, and the nono sandbox carries only a Pi login, so run it with --sandbox none")
    }
    const source = tokenFileSource(provider.tokenFile, choice.tokenFileFlag, Bun.env, choice.config.file)
    const tokenFile = yield* requireTokenFile(fs, models.agent, source)
    const env = { [tokenFileVar]: tokenFile }
    const key: ProviderKey = { provider: provider.id, apiKey: tokenFileApiKey }
    // Pi lists no model of a provider that has no key, so the key goes in before the windows are read.
    yield* writeAgentDir(fs, path, dirs.piAgentDir, key, [])
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, dirs.piAgentDir, env)
    yield* writeAgentDir(fs, path, dirs.piAgentDir, key, checked)
    return { kind: "none", own: { piAgentDir: dirs.piAgentDir, env } }
  })

export const planSandbox = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  choice: ProviderChoice,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> => {
  const { provider } = choice
  return provider.credential === "pi-login"
    ? planLogin(fs, path, spawner, host, dirs, models, { ...choice, provider }, sandboxKind)
    : planTokenFile(fs, path, spawner, host, dirs, models, { ...choice, provider }, sandboxKind)
}
