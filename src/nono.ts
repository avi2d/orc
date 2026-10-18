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

export const buildNonoProfile = (roots: NonoSandboxRoots) => ({
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
}) as const

export const buildNonoRunArgs = (profilePath: string, command: string): ReadonlyArray<string> => [
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

// An http(s) URL's userinfo is sent as the request's credentials.
const credentialBearingUrl = (raw: string): boolean => {
  if (!URL.canParse(raw)) {
    return false
  }
  const url = new URL(raw)
  return url.password !== "" || (url.username !== "" && (url.protocol === "https:" || url.protocol === "http:"))
}

const urlRewriteSuffixes: ReadonlyArray<string> = [".insteadof", ".pushinsteadof"]

// Git lowercases the section and variable name of every key it lists.
const credentialBearingEntry = (key: string, value: string): boolean => {
  if (key.startsWith("http.") && key.endsWith(".extraheader")) {
    return true
  }
  if (key.startsWith("credential.") && key.endsWith(".helper")) {
    return true
  }
  if (key.startsWith("remote.") && (key.endsWith(".url") || key.endsWith(".pushurl"))) {
    return credentialBearingUrl(value)
  }
  const rewrite = urlRewriteSuffixes.find((suffix) => key.startsWith("url.") && key.endsWith(suffix))
  return rewrite !== undefined && credentialBearingUrl(key.slice("url.".length, -rewrite.length))
}

const refuseCredentialBearingCheckout = (
  spawner: Spawner,
  worktree: string,
  gitEnv: Record<string, string>
): Effect.Effect<void, NonoProviderError> =>
  Effect.gen(function*() {
    const listing = yield* runHostCommand(
      spawner,
      ChildProcess.make("git", ["config", "--list", "-z"], { cwd: worktree, env: gitEnv, extendEnv: false })
    )
    if (listing.exitCode !== 0) {
      return yield* new NonoProviderError({
        reason: `orc nono provider: cannot read the git config of ${worktree}: ${listing.stderr.trim()}`
      })
    }
    const offending = listing.stdout.split("\0").flatMap((entry) => {
      const newline = entry.indexOf("\n")
      const key = newline === -1 ? entry : entry.slice(0, newline)
      const sectionAndVariable = `${key.slice(0, key.indexOf("."))}${key.slice(key.lastIndexOf("."))}`
      return credentialBearingEntry(key, newline === -1 ? "" : entry.slice(newline + 1)) ? [sectionAndVariable] : []
    })
    if (offending.length > 0) {
      return yield* new NonoProviderError({
        reason: `orc nono provider: the git config of ${worktree} carries a credential in ${offending.join(", ")}`
      })
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

const insideAny = (path: Path.Path, roots: ReadonlyArray<string>, target: string): boolean =>
  roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))

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
      yield* refuseCredentialBearingCheckout(spawner, worktree, buildSandboxEnv(Bun.env, tmpDir))
      const nonoBinary = yield* resolveNonoBinary(fs)
      const env = buildSandboxEnv({ ...Bun.env, ...createOptions.env }, tmpDir)
      const nono = (args: ReadonlyArray<string>) => ChildProcess.make(nonoBinary, args, { env, extendEnv: false })
      const profileDir = yield* fs.makeTempDirectory({ prefix: "orc-nono-" })
      const profilePath = path.join(profileDir, "profile.json")
      const hostTrustedPaths = [profileDir, nonoBinary, path.dirname(nonoBinary)]
      const canonicalRoots = yield* fs.writeFileString(profilePath, `${JSON.stringify(buildNonoProfile(roots), null, 2)}\n`).pipe(
        Effect.andThen(() => checkProfile(spawner, nono, profilePath, hostTrustedPaths)),
        Effect.andThen(() => fs.makeDirectory(tmpDir, { recursive: true })),
        Effect.andThen(() => Effect.forEach([roots.worktree, roots.gitData, roots.piSessionDir], (root) => fs.realPath(root))),
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
                (realCwd) => insideAny(path, canonicalRoots, realCwd),
                () => new NonoProviderError({ reason: `orc nono provider: working directory is outside the sandbox roots: ${cwd}` })
              ),
              Effect.andThen((realCwd) =>
                runHostCommand(
                  spawner,
                  ChildProcess.make(nonoBinary, buildNonoRunArgs(profilePath, command), {
                    cwd: realCwd,
                    env,
                    extendEnv: false,
                    stdin
                  }),
                  { onLine: execOptions?.onLine }
                )
              ),
              Effect.provide(BunServices.layer)
            )
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
