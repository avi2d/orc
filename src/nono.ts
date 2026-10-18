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

/**
 * The three writable roots of an orc agent sandbox.
 *
 * Every path the nono profile grants write access to derives from exactly
 * one of these roots, so nothing outside them can be expressed:
 * - `worktree`: the isolated copy the agent works in.
 * - `gitData`: the git common dir the copy's commits go into.
 * - `piSessionDir`: Pi's session folder for this run.
 */
export interface NonoSandboxRoots {
  readonly worktree: string
  readonly gitData: string
  readonly piSessionDir: string
}

/** A nono profile document as orc writes it for one sandbox. */
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
    readonly block: true
    readonly allow_domain: ReadonlyArray<string>
    readonly credentials: ReadonlyArray<string>
    readonly open_port: ReadonlyArray<number>
    readonly listen_port: ReadonlyArray<number>
    readonly no_proxy: ReadonlyArray<string>
    readonly upstream_bypass: ReadonlyArray<string>
  }
  readonly workdir: {
    readonly access: "readwrite"
  }
}

/**
 * Read-only toolchain groups the profile adds on top of the default base.
 * Every group here grants reads only; writes stay confined to the roots.
 * `nix_runtime` covers the Nix store shell this Mac resolves `sh` from,
 * `mise_manager` covers the mise installs of node and bun, and
 * `unlink_protection` blocks deletion everywhere except writable paths.
 */
const nonoGroups: ReadonlyArray<string> = [
  "node_runtime",
  "bun_runtime",
  "mise_manager",
  "nix_runtime",
  "git_config",
  "unlink_protection"
]

/**
 * Build the nono profile for one sandbox from its three writable roots.
 * The profile extends `default` (which denies credentials, keychains,
 * browser data, macOS private data, shell history and shell configs),
 * blocks all network, declares no credential of any kind, and grants
 * read-write access to the three roots and nothing else.
 */
export const buildNonoProfile = (roots: NonoSandboxRoots): NonoProfile => ({
  meta: {
    name: "orc-nono-agent",
    description: "orc agent sandbox: the isolated copy, its git data and Pi's session folder"
  },
  extends: "default",
  groups: {
    include: nonoGroups,
    exclude: []
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
    write_file: [],
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
    block: true,
    allow_domain: [],
    credentials: [],
    open_port: [],
    listen_port: [],
    no_proxy: [],
    upstream_bypass: []
  },
  workdir: {
    access: "readwrite"
  }
})

/** Inputs for one `nono run` invocation wrapping a sandboxed command. */
export interface NonoCommandInput {
  readonly nonoBinary: string
  readonly profilePath: string
  readonly command: string
}

/**
 * Build the argv that runs one command inside the sandbox.
 * The command travels as a single `sh -c` argument so the sandbox sees
 * exactly the string Sandcastle handed the provider, with no host-side
 * interpolation. Silent mode keeps nono's banner off the command's stdout,
 * which Sandcastle parses as agent output.
 */
export const buildNonoArgv = (input: NonoCommandInput): readonly [string, ...Array<string>] => [
  input.nonoBinary,
  "run",
  "--silent",
  "--profile",
  input.profilePath,
  // The handle always spawns with the worktree as its working directory,
  // which nono gates behind this flag even though the profile allows it.
  "--allow-cwd",
  "--",
  "sh",
  "-c",
  input.command
]

/**
 * GitHub credential variables stripped from every child environment.
 * The profile already grants no credential, and this makes doubly sure no
 * ambient `gh` token from the host can reach `git push` inside the sandbox.
 */
const githubCredentialVars: ReadonlyArray<string> = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
]

/** Copy an env mapping without any GitHub credential variable. */
export const scrubGitHubCredentials = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const scrubbed: Record<string, string | undefined> = { ...env }
  for (const name of githubCredentialVars) {
    delete scrubbed[name]
  }
  return scrubbed
}

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

/**
 * The orc nono provider: a Sandcastle bind-mount provider whose handle
 * `create` is part of the contract. Sandcastle 0.12.0's types omit the
 * runtime `create`, so this interface restores it.
 */
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
    const code: number = exitCode
    return { stdout: lines.join("\n"), stderr, exitCode: code }
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

/**
 * A Sandcastle bind-mount provider that wraps every command in
 * `nono run`, following the local-process shape from Sandcastle's README.
 * The provider builds a fresh nono profile from the run's three writable
 * roots (isolated copy, git data, Pi session folder), validates it, and
 * runs each command under it with no network, no credentials, and a
 * scrubbed environment. The sandbox handle's worktree is the host
 * worktree, so file copies are plain filesystem copies.
 */
export const nonoSandboxProvider = (options: NonoSandboxProviderOptions): NonoSandboxProvider => {
  const create = (createOptions: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
    const program = Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const nonoBinary = options.nonoBinary ?? "nono"
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
      const baseEnv = scrubGitHubCredentials({ ...Bun.env, ...createOptions.env })
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
          const [binary, ...args] = buildNonoArgv({ nonoBinary, profilePath, command })
          const stdin = execOptions?.stdin === undefined
            ? "ignore"
            : Stream.fromIterable([new TextEncoder().encode(execOptions.stdin)])
          return Effect.runPromise(
            runHostCommand(
              spawner,
              ChildProcess.make(binary, args, {
                cwd: execOptions?.cwd ?? worktree,
                env: baseEnv,
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
              // Best-effort cleanup of the rendered profile: keep the
              // outcome as a value, then drop it, so leftover temp files
              // are litter and never a sandbox teardown failure.
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
