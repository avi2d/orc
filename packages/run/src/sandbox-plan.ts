import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { SandboxKind } from "./args"
import { checkedModelWindows, contextMarkJson, type ModelProbe, readModelWindows } from "./context-mark"
import { requireTokenFile, tokenFileApiKey, tokenFileSource, tokenFileVar } from "./model-route"
import { inheritedEnv } from "./nono"
import { type CheckedModelWindow, type HostTools, loginCheckCommand, type ModelCredential, modelCredentialFor, piAgentModels, type ProviderKey, providerKeyOf } from "./nono-profile"
import type { LoginProvider, OrcConfig, PackageProvider, Provider, TokenFileProvider } from "./orc-config"
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
  key: ProviderKey | null,
  checked: ReadonlyArray<CheckedModelWindow>,
  packages: ReadonlyArray<string> = []
): Effect.Effect<void, OrcRunError> =>
  fs.writeFileString(path.join(piAgentDir, "models.json"), piAgentModels(key, checked)).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent models file: " + String(cause) })),
    Effect.andThen(() => fs.writeFileString(path.join(piAgentDir, "settings.json"), contextMarkJson(checked, packages)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent settings file: " + String(cause) }))
    ))
  )

const checkedAgentWindows = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  runDir: string,
  models: AgentModels,
  probe: ModelProbe,
  extraEnv: Readonly<Record<string, string>> = {}
): Effect.Effect<ReadonlyArray<CheckedModelWindow>, OrcRunError> =>
  readModelWindows(spawner, host, runDir, probe, extraEnv).pipe(
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
      const operatorAgentDir = Bun.env.PI_CODING_AGENT_DIR
      yield* checkedAgentWindows(spawner, host, dirs.runDir, models, operatorAgentDir === undefined ? { kind: "operator" } : { kind: "agent-dir", agentDir: operatorAgentDir, packages: false })
      return { kind: "none", own: null }
    }
    if (provider.nono === undefined) {
      return yield* refuse("orc: " + choice.config.file + " gives the provider " + provider.id + " no nono entry, so the nono sandbox cannot carry its key; add one with its upstream or run with --sandbox none")
    }
    const credential = modelCredentialFor({ id: provider.id, ...provider.nono }, host)
    yield* runLoginCheck(spawner, host, dirs.projectDir, provider.id, false)
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, { kind: "operator" })
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
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, { kind: "agent-dir", agentDir: dirs.piAgentDir, packages: false }, env)
    yield* writeAgentDir(fs, path, dirs.piAgentDir, key, checked)
    return { kind: "none", own: { piAgentDir: dirs.piAgentDir, env } }
  })

// The provider's own Pi package reaches its service, so the run's Pi folder names packages and holds no key.
const planPackage = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: HostTools,
  dirs: PlanDirs,
  models: AgentModels,
  choice: ProviderChoice<PackageProvider>,
  sandboxKind: SandboxKind
): Effect.Effect<SandboxPlan, OrcRunError> =>
  Effect.gen(function*() {
    const provider = choice.provider
    if (choice.tokenFileFlag !== undefined) {
      return yield* refuse("orc: --token-file names a token file, and " + choice.config.file + " has the provider " + provider.id + " reach its service through its Pi packages, so drop the flag")
    }
    if (sandboxKind === "nono") {
      return yield* refuse("orc: the implementer runs on model " + models.agent + ", whose provider " + provider.id + " reaches its service through its Pi packages, and the nono sandbox carries only a Pi login, so run it with --sandbox none")
    }
    const env = provider.env ?? {}
    // Pi installs the packages into the folder it reads and lists their models only after, so they go in before the windows are read.
    yield* writeAgentDir(fs, path, dirs.piAgentDir, null, [], provider.packages)
    const checked = yield* checkedAgentWindows(spawner, host, dirs.runDir, models, { kind: "agent-dir", agentDir: dirs.piAgentDir, packages: true }, env)
    yield* writeAgentDir(fs, path, dirs.piAgentDir, null, checked, provider.packages)
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
  switch (provider.credential) {
    case "pi-login":
      return planLogin(fs, path, spawner, host, dirs, models, { ...choice, provider }, sandboxKind)
    case "token-file":
      return planTokenFile(fs, path, spawner, host, dirs, models, { ...choice, provider }, sandboxKind)
    case "package":
      return planPackage(fs, path, spawner, host, dirs, models, { ...choice, provider }, sandboxKind)
  }
}
