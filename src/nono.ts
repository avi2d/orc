import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult
} from "@ai-hero/sandcastle"
import { BunServices } from "@effect/platform-bun"
import { Data, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  buildNonoArgv,
  buildNonoProfile,
  buildSandboxEnv,
  buildSessionGitConfigContents,
  scrubGitHubCredentials,
  type NonoGitIdentity,
  type NonoSandboxRoots
} from "./nono-profile"

export {
  buildNonoArgv,
  buildNonoProfile,
  buildSandboxEnv,
  buildSessionGitConfigContents,
  scrubGitHubCredentials
} from "./nono-profile"
export type { NonoCommandInput, NonoGitIdentity, NonoProfile, NonoSandboxEnvInput, NonoSandboxRoots } from "./nono-profile"

/** Every failure the orc nono provider can report. */
export class NonoProviderError extends Data.TaggedError("NonoProviderError")<{
  readonly reason: string
}> {}

/** Options for the orc nono sandbox provider. */
export interface NonoSandboxProviderOptions {
  /** Pi's session folder for this run, the third writable root. */
  readonly piSessionDir: string
  /** nono binary to invoke. Defaults to `nono` on PATH. */
  readonly nonoBinary?: string | undefined
}

/** A Sandcastle bind-mount provider with `create` restored on the type. */
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
    const handle = yield* spawner.spawn(command)
    const [lines, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.tap((line) => onLine === undefined ? Effect.void : Effect.sync(() => onLine(line))),
        Stream.runCollect
      ),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout: lines.join("\n"), stderr, exitCode }
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

const readGitConfigValue = (
  spawner: Spawner,
  worktree: string,
  key: string
): Effect.Effect<string | undefined> =>
  runHostCommand(spawner, ChildProcess.make("git", ["config", "--get", key], { cwd: worktree })).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })),
    Effect.map((result) => {
      if (result.exitCode !== 0) {
        return undefined
      }
      const value = result.stdout.trim()
      return value === "" ? undefined : value
    })
  )

const resolveHostGitIdentity = (
  spawner: Spawner,
  worktree: string
): Effect.Effect<NonoGitIdentity> =>
  Effect.gen(function*() {
    const userName = yield* readGitConfigValue(spawner, worktree, "user.name")
    const userEmail = yield* readGitConfigValue(spawner, worktree, "user.email")
    return { userName, userEmail }
  })

const canonicalizePath = (
  fs: FileSystem.FileSystem,
  candidate: string
): Effect.Effect<string> => fs.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate))

const prepareSessionFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  worktree: string,
  gitData: string,
  piSessionDir: string
) =>
  Effect.gen(function*() {
    yield* fs.makeDirectory(piSessionDir, { recursive: true })
    const canonicalWorktree = yield* canonicalizePath(fs, worktree)
    const canonicalGitData = yield* canonicalizePath(fs, gitData)
    const canonicalSessionDir = yield* canonicalizePath(fs, piSessionDir)
    const tmpDir = path.join(canonicalSessionDir, "tmp")
    yield* fs.makeDirectory(tmpDir, { recursive: true })
    const canonicalTmpDir = yield* canonicalizePath(fs, tmpDir)
    const identity = yield* resolveHostGitIdentity(spawner, worktree)
    const gitConfigPath = path.join(canonicalSessionDir, "gitconfig")
    yield* fs.writeFileString(gitConfigPath, buildSessionGitConfigContents(identity))
    return {
      roots: { worktree: canonicalWorktree, gitData: canonicalGitData, piSessionDir: canonicalSessionDir },
      sessionTmpDir: canonicalTmpDir,
      sessionGitConfigPath: gitConfigPath
    }
  })

const renderValidatedProfile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  nonoBinary: string,
  roots: NonoSandboxRoots
) =>
  Effect.gen(function*() {
    const profileDir = yield* fs.makeTempDirectory({ prefix: "orc-nono-" })
    const profilePath = path.join(profileDir, "profile.json")
    yield* fs.writeFileString(profilePath, `${JSON.stringify(buildNonoProfile(roots), null, 2)}\n`)
    const validation = yield* runHostCommand(
      spawner,
      ChildProcess.make(nonoBinary, ["profile", "validate", profilePath])
    )
    if (validation.exitCode !== 0) {
      return yield* new NonoProviderError({
        reason: `orc nono provider: profile failed validation: ${validation.stderr.trim()}`
      })
    }
    return { profileDir, profilePath }
  })

const makeHandle = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  args: {
    readonly worktree: string
    readonly nonoBinary: string
    readonly profilePath: string
    readonly profileDir: string
    readonly baseEnv: Record<string, string | undefined>
  }
): BindMountSandboxHandle => ({
  worktreePath: args.worktree,
  exec: (
    command: string,
    execOptions?: {
      readonly onLine?: ((line: string) => void) | undefined
      readonly cwd?: string | undefined
      readonly stdin?: string | undefined
    }
  ): Promise<ExecResult> => {
    const [binary, ...rest] = buildNonoArgv({ nonoBinary: args.nonoBinary, profilePath: args.profilePath, command })
    const stdin = execOptions?.stdin === undefined
      ? "ignore"
      : Stream.fromIterable([new TextEncoder().encode(execOptions.stdin)])
    return Effect.runPromise(
      runHostCommand(
        spawner,
        ChildProcess.make(binary, rest, {
          cwd: execOptions?.cwd ?? args.worktree,
          env: args.baseEnv,
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
      fs.remove(args.profileDir, { recursive: true }).pipe(
        Effect.result,
        Effect.asVoid,
        Effect.provide(BunServices.layer)
      )
    )
})

/** A Sandcastle bind-mount provider that wraps every command in `nono run`. */
export const nonoSandboxProvider = (options: NonoSandboxProviderOptions): NonoSandboxProvider => {
  const create = (createOptions: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
    const program = Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const nonoBinary = options.nonoBinary ?? "nono"
      const worktree = createOptions.worktreePath
      const gitData = yield* resolveGitDataDir(spawner, path, worktree)
      for (const root of [worktree, gitData, options.piSessionDir] as const) {
        if (!path.isAbsolute(root)) {
          return yield* new NonoProviderError({
            reason: `orc nono provider: sandbox root must be absolute: ${root}`
          })
        }
      }
      const session = yield* prepareSessionFiles(fs, path, spawner, worktree, gitData, options.piSessionDir)
      const rendered = yield* renderValidatedProfile(fs, path, spawner, nonoBinary, session.roots)
      const baseEnv = buildSandboxEnv(
        scrubGitHubCredentials({ ...Bun.env, ...createOptions.env }),
        { sessionTmpDir: session.sessionTmpDir, sessionGitConfigPath: session.sessionGitConfigPath }
      )
      return makeHandle(fs, path, spawner, {
        worktree,
        nonoBinary,
        profilePath: rendered.profilePath,
        profileDir: rendered.profileDir,
        baseEnv
      })
    })
    return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
  }
  return { ...createBindMountSandboxProvider({ name: "orc-nono", create }), create }
}
