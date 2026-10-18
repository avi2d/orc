import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult
} from "@ai-hero/sandcastle"
import { BunServices } from "@effect/platform-bun"
import { Data, Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface NonoSandboxRoots {
  readonly worktree: string
  readonly gitData: string
  readonly piSessionDir: string
}

export interface NonoProfile {
  readonly meta: {
    readonly name: string
    readonly description: string
  }
  readonly extends: "default"
  readonly groups: {
    readonly include: ReadonlyArray<string>
    readonly exclude: ReadonlyArray<string>
  }
  readonly security: {
    readonly signal_mode: "isolated"
    readonly capability_elevation: false
  }
  readonly filesystem: {
    readonly allow: ReadonlyArray<string>
    readonly read: ReadonlyArray<string>
    readonly write: ReadonlyArray<string>
    readonly allow_file: ReadonlyArray<string>
    readonly read_file: ReadonlyArray<string>
    readonly write_file: ReadonlyArray<string>
    readonly unix_socket: ReadonlyArray<string>
    readonly unix_socket_bind: ReadonlyArray<string>
    readonly unix_socket_dir: ReadonlyArray<string>
    readonly unix_socket_dir_bind: ReadonlyArray<string>
    readonly unix_socket_subtree: ReadonlyArray<string>
    readonly unix_socket_subtree_bind: ReadonlyArray<string>
    readonly deny: ReadonlyArray<string>
    readonly bypass_protection: ReadonlyArray<string>
    readonly suppress_save_prompt: ReadonlyArray<string>
  }
  readonly network: {
    readonly allow_domain: ReadonlyArray<string>
    readonly credentials: ReadonlyArray<string>
    readonly open_port: ReadonlyArray<number>
    readonly listen_port: ReadonlyArray<number>
    readonly no_proxy: ReadonlyArray<string>
    readonly upstream_bypass: ReadonlyArray<string>
  }
  readonly workdir: {
    readonly access: "none"
  }
}

// Every group here grants reads only.
const readOnlyToolchainGroups: ReadonlyArray<string> = [
  "node_runtime",
  "bun_runtime",
  "mise_manager",
  "nix_runtime",
  "unlink_protection"
]

// The default base grants writes to the system temp directories and /dev through these.
const systemWriteGroups: ReadonlyArray<string> = ["system_write_macos", "system_write_linux"]

export const buildNonoProfile = (roots: NonoSandboxRoots): NonoProfile => ({
  meta: {
    name: "orc-nono-agent",
    description: "orc agent sandbox: the isolated copy, its git data and Pi's session folder"
  },
  extends: "default",
  groups: {
    include: readOnlyToolchainGroups,
    exclude: systemWriteGroups
  },
  security: {
    signal_mode: "isolated",
    capability_elevation: false
  },
  filesystem: {
    allow: [roots.worktree, roots.gitData, roots.piSessionDir],
    read: [],
    write: [],
    allow_file: [],
    read_file: [],
    write_file: ["/dev/null"],
    unix_socket: [],
    unix_socket_bind: [],
    unix_socket_dir: [],
    unix_socket_dir_bind: [],
    unix_socket_subtree: [],
    unix_socket_subtree_bind: [],
    deny: [],
    bypass_protection: [],
    suppress_save_prompt: ["/"]
  },
  network: {
    allow_domain: [],
    credentials: [],
    open_port: [],
    listen_port: [],
    no_proxy: [],
    upstream_bypass: []
  },
  workdir: {
    access: "none"
  }
})

export const buildNonoArgv = (profilePath: string, command: string): readonly [string, ...Array<string>] => [
  "nono",
  "run",
  "--silent",
  "--profile",
  profilePath,
  "--",
  "sh",
  "-c",
  command
]

const inheritedEnvNames: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]

export const buildSandboxEnv = (
  hostEnv: Readonly<Record<string, string | undefined>>,
  tmpDir: string
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of inheritedEnvNames) {
    const value = hostEnv[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return { ...env, TMPDIR: tmpDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
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
    const stdoutChunks: Array<string> = []
    const handle = yield* spawner.spawn(command)
    const [, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(
        Stream.decodeText(),
        Stream.tap((chunk) => Effect.sync(() => stdoutChunks.push(chunk))),
        Stream.splitLines,
        Stream.tap((line) => onLine === undefined ? Effect.void : Effect.sync(() => onLine(line))),
        Stream.runDrain
      ),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    const code: number = exitCode
    return { stdout: stdoutChunks.join(""), stderr, exitCode: code }
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

const NonoWhyVerdict = Schema.fromJsonString(Schema.Struct({ status: Schema.Literals(["allowed", "denied"]) }))

const checkProfile = (
  spawner: Spawner,
  nono: (args: ReadonlyArray<string>) => ChildProcess.Command,
  profilePath: string,
  profileDir: string
): Effect.Effect<void, NonoProviderError> =>
  Effect.gen(function*() {
    const validation = yield* runHostCommand(spawner, nono(["profile", "validate", profilePath]))
    if (validation.exitCode !== 0) {
      return yield* new NonoProviderError({
        reason: `orc nono provider: profile failed validation: ${validation.stderr.trim()}`
      })
    }
    const profileWrite = yield* runHostCommand(
      spawner,
      nono(["why", "--json", "--profile", profilePath, "--path", profileDir, "--op", "write"])
    )
    const verdict = yield* Schema.decodeEffect(NonoWhyVerdict)(profileWrite.stdout).pipe(
      Effect.mapError((cause) =>
        new NonoProviderError({ reason: `orc nono provider: cannot read nono's profile verdict: ${String(cause)}` })
      )
    )
    if (verdict.status !== "denied") {
      return yield* new NonoProviderError({
        reason: `orc nono provider: the sandbox could rewrite its own profile in ${profileDir}`
      })
    }
  })

export const nonoSandboxProvider = (options: NonoSandboxProviderOptions): NonoSandboxProvider => {
  const create = (createOptions: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
    const program = Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const worktree = createOptions.worktreePath
      const gitData = yield* resolveGitDataDir(spawner, path, worktree)
      const roots: NonoSandboxRoots = { worktree, gitData, piSessionDir: options.piSessionDir }
      for (const root of [roots.worktree, roots.gitData, roots.piSessionDir] as const) {
        if (!path.isAbsolute(root)) {
          return yield* new NonoProviderError({
            reason: `orc nono provider: sandbox root must be absolute: ${root}`
          })
        }
      }
      const tmpDir = path.join(roots.piSessionDir, "tmp")
      const env = buildSandboxEnv({ ...Bun.env, ...createOptions.env }, tmpDir)
      const nono = (args: ReadonlyArray<string>) => ChildProcess.make("nono", args, { env, extendEnv: false })
      const profileDir = yield* fs.makeTempDirectory({ prefix: "orc-nono-" })
      const profilePath = path.join(profileDir, "profile.json")
      yield* fs.writeFileString(profilePath, `${JSON.stringify(buildNonoProfile(roots), null, 2)}\n`).pipe(
        Effect.andThen(() => checkProfile(spawner, nono, profilePath, profileDir)),
        Effect.andThen(() => fs.makeDirectory(tmpDir, { recursive: true })),
        Effect.onError(() => fs.remove(profileDir, { recursive: true }).pipe(Effect.result))
      )
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
          const [binary, ...args] = buildNonoArgv(profilePath, command)
          const stdin = execOptions?.stdin === undefined
            ? "ignore"
            : Stream.fromIterable([new TextEncoder().encode(execOptions.stdin)])
          return Effect.runPromise(
            runHostCommand(
              spawner,
              ChildProcess.make(binary, args, {
                cwd: execOptions?.cwd ?? worktree,
                env,
                extendEnv: false,
                stdin
              }),
              { onLine: execOptions?.onLine }
            ).pipe(Effect.provide(BunServices.layer))
          )
        },
        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          Effect.runPromise(
            fs.makeDirectory(path.dirname(sandboxPath), { recursive: true }).pipe(
              Effect.andThen(() => fs.copy(hostPath, sandboxPath)),
              Effect.provide(BunServices.layer)
            )
          ),
        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          Effect.runPromise(
            fs.makeDirectory(path.dirname(hostPath), { recursive: true }).pipe(
              Effect.andThen(() => fs.copy(sandboxPath, hostPath)),
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
