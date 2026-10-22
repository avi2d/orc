import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult
} from "@ai-hero/sandcastle"
import { BunServices } from "@effect/platform-bun"
import { Effect, FiberSet, FileSystem, Path, Schema, Scope, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import {
  closeNonoSandbox,
  type HostCommandResult,
  hostGitSafetyEnv,
  NonoProviderError,
  prepareSandboxShims,
  resolveDeveloperDir,
  resolveHostBinary,
  resolvePiAgentDir,
  resolveRuntime,
  runHostCommand,
  type Spawner
} from "./host"
import { credentialBearingKeys, includePathKeys, includeTargets, submoduleCheckouts } from "./git-config"
import { selectNonoProfile, type ModelCredential, type NonoSandboxRoots, within } from "./nono-profile"

export const buildNonoRunArgs = (
  profilePath: string,
  command: string,
  positional: ReadonlyArray<string> = []
): ReadonlyArray<string> => ["run", "--silent", "--profile", profilePath, "--", "sh", "-c", command, "sh", ...positional]

const inheritedEnvNames: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]

const sandboxRuntimes: ReadonlyArray<string> = ["bun", "node", "pi"]

const inheritedEnv = (hostEnv: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of inheritedEnvNames) {
    const value = hostEnv[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return env
}

// Sandcastle writes safe.directory and the commit identity with `git config --global`, so the global config must be writable.
export const buildSandboxEnv = (
  hostEnv: Readonly<Record<string, string | undefined>>,
  piSessionDir: string,
  runtimeBinDirs: ReadonlyArray<string>
): Readonly<Record<string, string>> & { readonly TMPDIR: string } => {
  const env = inheritedEnv(hostEnv)
  return {
    ...env,
    PATH: [...runtimeBinDirs, ...(hostEnv.PATH === undefined ? [] : [hostEnv.PATH])].join(":"),
    TMPDIR: `${piSessionDir}/tmp`,
    // xcrun finds its default cache through confstr, not TMPDIR, and without a writable cache every /usr/bin/git call reruns xcodebuild -find.
    xcrun_db: `${piSessionDir}/tmp/xcrun_db`,
    GIT_CONFIG_GLOBAL: `${piSessionDir}/gitconfig`,
    GIT_CONFIG_SYSTEM: "/dev/null"
  }
}

const sandboxEnv = (
  hostEnv: NodeJS.ProcessEnv,
  piSessionDir: string,
  runtimeBinDirs: ReadonlyArray<string>,
  agentDir: Record<string, string>
): Readonly<Record<string, string>> & { readonly TMPDIR: string } => ({
  ...buildSandboxEnv(hostEnv, piSessionDir, [...new Set(runtimeBinDirs)]),
  ...agentDir
})

export const buildHostGitEnv = (hostEnv: Readonly<Record<string, string | undefined>>): Record<string, string> => ({
  ...inheritedEnv(hostEnv),
  ...hostGitSafetyEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
})

export { NonoProviderError }

export interface NonoSandboxProviderOptions {
  readonly piSessionDir: string
  readonly piAgentDir?: string | undefined
  readonly modelCredential?: ModelCredential | undefined
  readonly hostPath?: string | undefined
}

// Sandcastle 0.12.0's provider type omits the runtime `create`.
export interface NonoSandboxProvider extends BindMountSandboxProvider {
  readonly create: (options: BindMountCreateOptions) => Promise<BindMountSandboxHandle>
}

interface HostGit {
  readonly binary: string
  readonly env: Record<string, string>
}

const resolveGitDataDir = (
  spawner: Spawner,
  path: Path.Path,
  { binary, env }: HostGit,
  worktree: string
): Effect.Effect<string, NonoProviderError> =>
  Effect.gen(function*() {
    const result = yield* runHostCommand(
      spawner,
      ChildProcess.make(binary, ["rev-parse", "--git-common-dir"], { cwd: worktree, env, extendEnv: false })
    )
    if (result.exitCode !== 0) {
      return yield* new NonoProviderError({
        message: `orc nono provider: cannot resolve git data dir for ${worktree}: ${result.stderr.trim()}`
      })
    }
    const raw = result.stdout.trim()
    return path.isAbsolute(raw) ? raw : path.join(worktree, raw)
  })

// A file that cannot be read may hold a credential, so only a missing one is skipped.
const unlessAbsent = <A>(absent: A, target: string) => (effect: Effect.Effect<A, PlatformError>): Effect.Effect<A, NonoProviderError> =>
  effect.pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(absent)),
    Effect.mapError((cause) =>
      new NonoProviderError({ message: `orc nono provider: cannot scan ${target} for credentials: ${cause.message}` })
    )
  )

const gitDirsUnder = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
  fs.readDirectory(root, { recursive: true }).pipe(
    Effect.map((entries) => entries.filter((entry) => path.basename(entry) === "HEAD").map((entry) => path.join(root, path.dirname(entry)))),
    unlessAbsent<ReadonlyArray<string>>([], root)
  )

const gitDirConfigs = (fs: FileSystem.FileSystem, path: Path.Path, gitDir: string) =>
  Effect.gen(function*() {
    const gitDirs = [
      gitDir,
      ...(yield* gitDirsUnder(fs, path, path.join(gitDir, "worktrees"))),
      ...(yield* gitDirsUnder(fs, path, path.join(gitDir, "modules")))
    ]
    return gitDirs.flatMap((dir) => [path.join(dir, "config"), path.join(dir, "config.worktree")])
  })

const checkoutConfigs = (fs: FileSystem.FileSystem, path: Path.Path, checkout: string) =>
  Effect.gen(function*() {
    const dotGit = path.join(checkout, ".git")
    const info = yield* fs.stat(dotGit).pipe(Effect.map((stat) => stat.type), unlessAbsent<string>("absent", dotGit))
    const embedded = info === "Directory" ? yield* gitDirConfigs(fs, path, dotGit) : []
    return [path.join(checkout, ".gitmodules"), ...embedded]
  })

// Git refuses to read a config whose includes nest deeper than this.
const maxIncludeDepth = 10

const readGitConfig = (spawner: Spawner, { binary, env }: HostGit, file: string, query: ReadonlyArray<string>, matchless: boolean) =>
  runHostCommand(spawner, ChildProcess.make(binary, ["config", "--file", file, "--no-includes", "-z", ...query], { env, extendEnv: false })).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0 || (matchless && result.exitCode === 1 && result.stderr === "")) {
        return Effect.succeed(result.stdout)
      }
      return Effect.fail(new NonoProviderError({ message: `orc nono provider: cannot read the git config ${file}: ${result.stderr.trim()}` }))
    })
  )

// The sandbox can read every config in the git data, every .gitmodules and embedded submodule git dir in the checkout, and every file they include, active or not.
const refuseCredentialBearingCheckout = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  roots: NonoSandboxRoots,
  hostGit: HostGit
): Effect.Effect<void, NonoProviderError> =>
  Effect.gen(function*() {
    const topLevel = [...(yield* gitDirConfigs(fs, path, roots.gitData)), ...(yield* checkoutConfigs(fs, path, roots.worktree))]
    const pending = topLevel.map((file) => ({ file, depth: 0 }))
    const seen = new Set<string>()
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      const { file, depth } = next
      if (seen.has(file) || !(yield* fs.stat(file).pipe(Effect.as(true), unlessAbsent(false, file)))) {
        continue
      }
      if (depth > maxIncludeDepth) {
        return yield* new NonoProviderError({ message: `orc nono provider: the git config ${file} is included deeper than git reads` })
      }
      seen.add(file)
      const listing = yield* readGitConfig(spawner, hostGit, file, ["--list"], false)
      const offending = credentialBearingKeys(listing)
      if (offending.length > 0) {
        return yield* new NonoProviderError({
          message: `orc nono provider: the git config ${file} carries a credential in ${offending.join(", ")}`
        })
      }
      const includes = yield* readGitConfig(spawner, hostGit, file, ["--type=path", "--get-regexp", includePathKeys], true)
      pending.push(...includeTargets(path, file, includes).map((target) => ({ file: target, depth: depth + 1 })))
      if (path.basename(file) === ".gitmodules") {
        for (const checkout of submoduleCheckouts(path, file, listing).filter((dir) => within(roots.worktree, dir))) {
          pending.push(...(yield* checkoutConfigs(fs, path, checkout)).map((nested) => ({ file: nested, depth: 0 })))
        }
      }
    }
  })

// nono resolves a grant's symlinks afresh on every run, so only canonical roots keep their meaning.
const resolveRoots = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  hostGit: HostGit,
  worktree: string,
  piSessionDir: string
): Effect.Effect<NonoSandboxRoots, NonoProviderError | PlatformError> =>
  Effect.gen(function*() {
    for (const root of [worktree, piSessionDir]) {
      if (!path.isAbsolute(root)) {
        return yield* new NonoProviderError({ message: `orc nono provider: sandbox root must be absolute: ${root}` })
      }
    }
    const gitData = yield* resolveGitDataDir(spawner, path, hostGit, worktree)
    yield* fs.makeDirectory(piSessionDir, { recursive: true })
    return {
      worktree: yield* fs.realPath(worktree),
      gitData: yield* fs.realPath(gitData),
      piSessionDir: yield* fs.realPath(piSessionDir)
    }
  })

const requireSuccess = (action: string) => (result: HostCommandResult): Effect.Effect<HostCommandResult, NonoProviderError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(new NonoProviderError({ message: `orc nono provider: cannot ${action}: ${result.stderr.trim()}` }))

interface Sandbox {
  readonly nonoBinary: string
  readonly profilePath: string
  readonly env: Readonly<Record<string, string>>
}

interface SandboxedRun {
  readonly cwd: string
  readonly stdin: "ignore" | Stream.Stream<Uint8Array>
  readonly onLine?: ((line: string) => void) | undefined
  readonly positional?: ReadonlyArray<string>
}

const runSandboxed = (
  spawner: Spawner,
  sandbox: Sandbox,
  command: string,
  run: SandboxedRun
): Effect.Effect<HostCommandResult, NonoProviderError> =>
  runHostCommand(
    spawner,
    ChildProcess.make(sandbox.nonoBinary, buildNonoRunArgs(sandbox.profilePath, command, run.positional), {
      cwd: run.cwd,
      env: sandbox.env,
      extendEnv: false,
      stdin: run.stdin,
      forceKillAfter: "1 second"
    }),
    { onLine: run.onLine }
  )

const NonoWhyVerdict = Schema.fromJsonString(Schema.Struct({ status: Schema.Literals(["allowed", "denied"]) }))

const checkProfile = (
  spawner: Spawner,
  nono: (args: ReadonlyArray<string>) => ChildProcess.Command,
  profilePath: string,
  hostTrustedPaths: ReadonlyArray<string>
): Effect.Effect<void, NonoProviderError> =>
  Effect.gen(function*() {
    const validation = yield* runHostCommand(spawner, nono(["profile", "validate", profilePath]))
    if (validation.exitCode !== 0) {
      return yield* new NonoProviderError({
        message: `orc nono provider: profile failed validation: ${validation.stderr.trim()}`
      })
    }
    for (const trusted of hostTrustedPaths) {
      const write = yield* runHostCommand(
        spawner,
        nono(["why", "--json", "--profile", profilePath, "--path", trusted, "--op", "write"])
      )
      const verdict = yield* Schema.decodeEffect(NonoWhyVerdict)(write.stdout).pipe(
        Effect.mapError((cause) =>
          new NonoProviderError({ message: `orc nono provider: cannot read nono's write verdict for ${trusted} (exit ${write.exitCode}): ${write.stdout.slice(0, 200)} ${write.stderr.slice(0, 500)}: ${String(cause)}` })
        )
      )
      if (verdict.status !== "denied") {
        return yield* new NonoProviderError({
          message: `orc nono provider: the sandbox could write ${trusted}, which the host runs or reads as policy`
        })
      }
    }
  })

export const nonoSandboxProvider = (options: NonoSandboxProviderOptions): NonoSandboxProvider => {
  const create = (createOptions: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
    const program = Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const hostEnv = { ...Bun.env, ...(options.hostPath === undefined ? {} : { PATH: options.hostPath }), ...createOptions.env }
      const hostGit = { binary: yield* resolveHostBinary(fs, "git"), env: buildHostGitEnv(hostEnv) }
      const roots = yield* resolveRoots(spawner, fs, path, hostGit, createOptions.worktreePath, options.piSessionDir)
      yield* refuseCredentialBearingCheckout(spawner, fs, path, roots, hostGit)
      const runtimes = (yield* Effect.forEach(sandboxRuntimes, (name) => resolveRuntime(fs, path, name, Bun.env.PATH ?? "", homedir()))).filter((runtime) => runtime !== null)
      const agentDir = yield* resolvePiAgentDir(fs, roots.piSessionDir, options.piAgentDir)
      const shims = yield* prepareSandboxShims(fs, path, roots.piSessionDir)
      const env = sandboxEnv(hostEnv, roots.piSessionDir, [shims.shimDir, ...runtimes.map((runtime) => runtime.binDir)], agentDir)
      const runtimeDirs = runtimes.flatMap((runtime) => runtime.installDir === null ? [] : [runtime.installDir])
      const developerDir = yield* resolveDeveloperDir(spawner, fs, env)
      const nonoBinary = yield* resolveHostBinary(fs, "nono")
      const nono = (args: ReadonlyArray<string>) => ChildProcess.make(nonoBinary, args, { env, extendEnv: false })
      const profileDir = yield* fs.makeTempDirectory({ prefix: "orc-nono-" })
      const profilePath = path.join(profileDir, "profile.json")
      const hostTrustedPaths = [profileDir, nonoBinary, path.dirname(nonoBinary)]
      const profile = yield* selectNonoProfile(roots, { developerDir, runtimeDirs }, options.modelCredential)
      yield* fs.writeFileString(profilePath, `${JSON.stringify(profile, null, 2)}\n`).pipe(
        Effect.andThen(() => checkProfile(spawner, nono, profilePath, hostTrustedPaths)),
        Effect.andThen(() => fs.makeDirectory(env.TMPDIR, { recursive: true })),
        Effect.onError(() => fs.remove(profileDir, { recursive: true }).pipe(Effect.result))
      )
      const sandboxed = (command: string, run: SandboxedRun) => runSandboxed(spawner, { nonoBinary, profilePath, env }, command, run)
      const lifetime = yield* Scope.make()
      const runOwned = yield* FiberSet.makeRuntimePromise().pipe(Scope.provide(lifetime))
      return {
        worktreePath: createOptions.worktreePath,
        exec: (
          command: string,
          execOptions?: {
            readonly onLine?: ((line: string) => void) | undefined
            readonly cwd?: string | undefined
            readonly stdin?: string | undefined
          }
        ): Promise<ExecResult> => {
          const cwd = execOptions?.cwd ?? createOptions.worktreePath
          const stdin = execOptions?.stdin === undefined ? "ignore" : Stream.fromIterable([new TextEncoder().encode(execOptions.stdin)])
          return runOwned(
            fs.realPath(cwd).pipe(
              Effect.mapError((cause) =>
                new NonoProviderError({ message: `orc nono provider: cannot resolve working directory ${cwd}: ${String(cause)}` })
              ),
              Effect.filterOrFail(
                (realCwd) => [roots.worktree, roots.gitData, roots.piSessionDir].some((root) => within(root, realCwd)),
                () => new NonoProviderError({ message: `orc nono provider: working directory is outside the sandbox roots: ${cwd}` })
              ),
              Effect.andThen((realCwd) => sandboxed(command, { cwd: realCwd, stdin, onLine: execOptions?.onLine })),
              Effect.map(({ stdout, stderr, exitCode }) => ({ stdout, stderr, exitCode })),
              Effect.provide(BunServices.layer)
            )
          )
        },
        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          runOwned(
            fs.readFile(hostPath).pipe(
              Effect.andThen((bytes) =>
                sandboxed(`mkdir -p -- "$(dirname -- "$1")" && cat > "$1"`, {
                  cwd: roots.worktree,
                  stdin: Stream.fromIterable([bytes]),
                  positional: [sandboxPath]
                })
              ),
              Effect.andThen(requireSuccess(`copy ${hostPath} into the sandbox at ${sandboxPath}`)),
              Effect.asVoid,
              Effect.provide(BunServices.layer)
            )
          ),
        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          runOwned(
            sandboxed(`cat -- "$1"`, { cwd: roots.worktree, stdin: "ignore", positional: [sandboxPath] }).pipe(
              Effect.andThen(requireSuccess(`copy ${sandboxPath} out of the sandbox`)),
              Effect.andThen(({ stdoutBytes }) =>
                fs.makeDirectory(path.dirname(hostPath), { recursive: true }).pipe(
                  Effect.andThen(() => fs.writeFile(hostPath, stdoutBytes))
                )
              ),
              Effect.provide(BunServices.layer)
            )
          ),
        close: (): Promise<void> => closeNonoSandbox(lifetime, profileDir, shims.shimDir)
      } satisfies BindMountSandboxHandle
    })
    return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
  }
  return { ...createBindMountSandboxProvider({ name: "orc-nono", create }), create }
}
