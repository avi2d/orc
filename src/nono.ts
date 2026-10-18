import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult
} from "@ai-hero/sandcastle"
import { BunServices } from "@effect/platform-bun"
import { Data, Effect, FileSystem, Path, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { credentialBearingKeys, includeTargets } from "./git-config"
import { buildNonoProfile, type NonoSandboxRoots, within } from "./nono-profile"

export const buildNonoRunArgs = (
  profilePath: string,
  command: string,
  positional: ReadonlyArray<string> = []
): ReadonlyArray<string> => ["run", "--silent", "--profile", profilePath, "--", "sh", "-c", command, "sh", ...positional]

const inheritedEnvNames: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]

// Sandcastle writes safe.directory and the commit identity with `git config --global`, so the global config must be writable.
export const buildSandboxEnv = (
  hostEnv: Readonly<Record<string, string | undefined>>,
  piSessionDir: string
): Readonly<Record<string, string>> & { readonly TMPDIR: string } => {
  const env: Record<string, string> = {}
  for (const name of inheritedEnvNames) {
    const value = hostEnv[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return {
    ...env,
    TMPDIR: `${piSessionDir}/tmp`,
    GIT_CONFIG_GLOBAL: `${piSessionDir}/gitconfig`,
    GIT_CONFIG_SYSTEM: "/dev/null"
  }
}

export class NonoProviderError extends Data.TaggedError("NonoProviderError")<{
  readonly reason: string
}> {}

export interface NonoSandboxProviderOptions {
  readonly piSessionDir: string
}

// Sandcastle 0.12.0's provider type omits the runtime `create`.
export interface NonoSandboxProvider extends BindMountSandboxProvider {
  readonly create: (options: BindMountCreateOptions) => Promise<BindMountSandboxHandle>
}

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

interface HostCommandResult {
  readonly stdout: string
  readonly stdoutBytes: Uint8Array
  readonly stderr: string
  readonly exitCode: number
}

const runHostCommand = (
  spawner: Spawner,
  command: ChildProcess.Command,
  options?: {
    readonly onLine?: ((line: string) => void) | undefined
  }
): Effect.Effect<HostCommandResult, NonoProviderError> =>
  Effect.scoped(Effect.gen(function*() {
    const onLine = options?.onLine
    const stdoutChunks: Array<Uint8Array> = []
    const handle = yield* spawner.spawn(command)
    const [, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(
        Stream.tap((chunk) => Effect.sync(() => stdoutChunks.push(chunk))),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.tap((line) => onLine === undefined ? Effect.void : Effect.sync(() => onLine(line))),
        Stream.runDrain
      ),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    const code: number = exitCode
    const stdoutBytes = Buffer.concat(stdoutChunks)
    return { stdout: new TextDecoder().decode(stdoutBytes), stdoutBytes, stderr, exitCode: code }
  })).pipe(
    Effect.mapError(
      (cause) => new NonoProviderError({ reason: `orc nono provider: command failed to run: ${String(cause)}` })
    )
  )

const resolveGitDataDir = (
  spawner: Spawner,
  path: Path.Path,
  worktree: string
): Effect.Effect<string, NonoProviderError> =>
  Effect.gen(function*() {
    const result = yield* runHostCommand(
      spawner,
      ChildProcess.make("git", ["rev-parse", "--git-common-dir"], { cwd: worktree })
    )
    if (result.exitCode !== 0) {
      return yield* new NonoProviderError({
        reason: `orc nono provider: cannot resolve git data dir for ${worktree}: ${result.stderr.trim()}`
      })
    }
    const raw = result.stdout.trim()
    return path.isAbsolute(raw) ? raw : path.join(worktree, raw)
  })

// Every config file in the git data is readable from the sandbox, and so is every file they include, active or not.
const refuseCredentialBearingCheckout = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  gitData: string,
  home: string | undefined,
  gitEnv: Record<string, string>
): Effect.Effect<void, NonoProviderError> =>
  Effect.gen(function*() {
    const worktreeConfigs = yield* fs.readDirectory(path.join(gitData, "worktrees")).pipe(
      Effect.map((names) => names.map((name) => path.join(gitData, "worktrees", name, "config.worktree"))),
      Effect.orElseSucceed((): ReadonlyArray<string> => [])
    )
    const pending = [path.join(gitData, "config"), path.join(gitData, "config.worktree"), ...worktreeConfigs]
    const seen = new Set<string>()
    for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
      if (seen.has(file) || !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
        continue
      }
      seen.add(file)
      const listing = yield* runHostCommand(
        spawner,
        ChildProcess.make("git", ["config", "--file", file, "--no-includes", "--list", "-z"], { env: gitEnv, extendEnv: false })
      )
      if (listing.exitCode !== 0) {
        return yield* new NonoProviderError({
          reason: `orc nono provider: cannot read the git config ${file}: ${listing.stderr.trim()}`
        })
      }
      const offending = credentialBearingKeys(listing.stdout)
      if (offending.length > 0) {
        return yield* new NonoProviderError({
          reason: `orc nono provider: the git config ${file} carries a credential in ${offending.join(", ")}`
        })
      }
      pending.push(...includeTargets(path, home, file, listing.stdout))
    }
  })

const resolveNonoBinary = (fs: FileSystem.FileSystem): Effect.Effect<string, NonoProviderError> => {
  const found = Bun.which("nono")
  return found === null
    ? Effect.fail(new NonoProviderError({ reason: "orc nono provider: nono is not on the host PATH" }))
    : fs.realPath(found).pipe(
      Effect.mapError((cause) => new NonoProviderError({ reason: `orc nono provider: cannot resolve nono: ${String(cause)}` }))
    )
}

// nono resolves a grant's symlinks afresh on every run, so only canonical roots keep their meaning.
const resolveRoots = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  worktree: string,
  piSessionDir: string
): Effect.Effect<NonoSandboxRoots, NonoProviderError | PlatformError> =>
  Effect.gen(function*() {
    for (const root of [worktree, piSessionDir]) {
      if (!path.isAbsolute(root)) {
        return yield* new NonoProviderError({ reason: `orc nono provider: sandbox root must be absolute: ${root}` })
      }
    }
    const gitData = yield* resolveGitDataDir(spawner, path, worktree)
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
    : Effect.fail(new NonoProviderError({ reason: `orc nono provider: cannot ${action}: ${result.stderr.trim()}` }))

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
      stdin: run.stdin
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
        reason: `orc nono provider: profile failed validation: ${validation.stderr.trim()}`
      })
    }
    for (const trusted of hostTrustedPaths) {
      const write = yield* runHostCommand(
        spawner,
        nono(["why", "--json", "--profile", profilePath, "--path", trusted, "--op", "write"])
      )
      const verdict = yield* Schema.decodeEffect(NonoWhyVerdict)(write.stdout).pipe(
        Effect.mapError((cause) =>
          new NonoProviderError({ reason: `orc nono provider: cannot read nono's write verdict: ${String(cause)}` })
        )
      )
      if (verdict.status !== "denied") {
        return yield* new NonoProviderError({
          reason: `orc nono provider: the sandbox could write ${trusted}, which the host runs or reads as policy`
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
      const worktree = createOptions.worktreePath
      const roots = yield* resolveRoots(spawner, fs, path, worktree, options.piSessionDir)
      const env = buildSandboxEnv({ ...Bun.env, ...createOptions.env }, roots.piSessionDir)
      yield* refuseCredentialBearingCheckout(spawner, fs, path, roots.gitData, env.HOME, buildSandboxEnv(Bun.env, roots.piSessionDir))
      const nonoBinary = yield* resolveNonoBinary(fs)
      const nono = (args: ReadonlyArray<string>) => ChildProcess.make(nonoBinary, args, { env, extendEnv: false })
      const profileDir = yield* fs.makeTempDirectory({ prefix: "orc-nono-" })
      const profilePath = path.join(profileDir, "profile.json")
      const hostTrustedPaths = [profileDir, nonoBinary, path.dirname(nonoBinary)]
      yield* fs.writeFileString(profilePath, `${JSON.stringify(buildNonoProfile(roots), null, 2)}\n`).pipe(
        Effect.andThen(() => checkProfile(spawner, nono, profilePath, hostTrustedPaths)),
        Effect.andThen(() => fs.makeDirectory(env.TMPDIR, { recursive: true })),
        Effect.onError(() => fs.remove(profileDir, { recursive: true }).pipe(Effect.result))
      )
      const sandboxed = (command: string, run: SandboxedRun) => runSandboxed(spawner, { nonoBinary, profilePath, env }, command, run)
      return {
        worktreePath: worktree,
        exec: (
          command: string,
          execOptions?: {
            readonly onLine?: ((line: string) => void) | undefined
            readonly cwd?: string | undefined
            readonly stdin?: string | undefined
          }
        ): Promise<ExecResult> => {
          const cwd = execOptions?.cwd ?? worktree
          const stdin = execOptions?.stdin === undefined
            ? "ignore"
            : Stream.fromIterable([new TextEncoder().encode(execOptions.stdin)])
          return Effect.runPromise(
            fs.realPath(cwd).pipe(
              Effect.mapError((cause) =>
                new NonoProviderError({ reason: `orc nono provider: cannot resolve working directory ${cwd}: ${String(cause)}` })
              ),
              Effect.filterOrFail(
                (realCwd) => [roots.worktree, roots.gitData, roots.piSessionDir].some((root) => within(root, realCwd)),
                () => new NonoProviderError({ reason: `orc nono provider: working directory is outside the sandbox roots: ${cwd}` })
              ),
              Effect.andThen((realCwd) => sandboxed(command, { cwd: realCwd, stdin, onLine: execOptions?.onLine })),
              Effect.map(({ stdout, stderr, exitCode }) => ({ stdout, stderr, exitCode })),
              Effect.provide(BunServices.layer)
            )
          )
        },
        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          Effect.runPromise(
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
          Effect.runPromise(
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
        close: (): Promise<void> =>
          Effect.runPromise(
            fs.remove(profileDir, { recursive: true }).pipe(
              // A leftover rendered profile is litter, never a teardown failure.
              Effect.result,
              Effect.asVoid,
              Effect.provide(BunServices.layer)
            )
          )
      } satisfies BindMountSandboxHandle
    })
    return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
  }
  return { ...createBindMountSandboxProvider({ name: "orc-nono", create }), create }
}
