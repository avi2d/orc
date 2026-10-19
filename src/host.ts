import { Data, Effect, FileSystem, type Path, type PlatformError, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Runtime, runtimeOf, within } from "./nono-profile"

export class NonoProviderError extends Data.TaggedError("NonoProviderError")<{
  readonly message: string
}> {}

export type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

// The sandbox can write the hooks host git runs and the submodule git dirs it recurses into; config from the environment outranks both.
export const hostGitSafetyEnv = {
  GIT_ALLOW_PROTOCOL: "file:git:ssh:http:https",
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "diff.ignoreSubmodules",
  GIT_CONFIG_VALUE_1: "all",
  GIT_CONFIG_KEY_2: "submodule.recurse",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "fetch.recurseSubmodules",
  GIT_CONFIG_VALUE_3: "false"
} as const

export const hostGitRefusalExit = 97

// Git keeps adding repository config that runs a program, so only keys known to run none pass.
const inertRepositoryKeys = [
  "core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol)",
  "extensions\\.(objectformat|refstorage|worktreeconfig)",
  "remote\\..*\\.(url|pushurl|fetch|push|tagopt|prune|mirror)",
  "branch\\..*\\.(remote|merge|pushremote|description)",
  "submodule\\..*\\.(url|active|ignore)",
  "user\\.(name|email)"
]

const shellQuote = (arg: string): string => "'" + arg.replace(/'/g, "'\\''") + "'"

// The sandbox writes the repository config host git reads, and per-submodule ignore settings are keyed by names it picks, so the shim checks what git would read before every host git command.
const hostGitShimScript = (realGit: string): string =>
  [
    "#!/bin/sh",
    "set -f",
    "IFS='",
    "'",
    "git=" + shellQuote(realGit),
    "if ! listing=$(\"$git\" config --list --show-scope --name-only); then",
    "  echo 'orc: git cannot read the repository config, so orc runs no git command here' >&2",
    "  exit " + hostGitRefusalExit.toString(),
    "fi",
    "refused=$(printf '%s\\n' \"$listing\" | awk -F '\\t' '$1 == \"local\" || $1 == \"worktree\" { print $2 }' | grep -Ev " +
      shellQuote("^(" + inertRepositoryKeys.join("|") + ")$") + ")",
    "if [ -n \"$refused\" ]; then",
    "  echo \"orc: the repository git config sets $(printf '%s ' $refused)and orc lets host git read only config that runs no program\" >&2",
    "  exit " + hostGitRefusalExit.toString(),
    "fi",
    "n=${GIT_CONFIG_COUNT:-0}",
    "override() {",
    "  export \"GIT_CONFIG_KEY_$n=$1\" \"GIT_CONFIG_VALUE_$n=$2\"",
    "  n=$((n + 1))",
    "}",
    "top=$(\"$git\" rev-parse --show-toplevel 2>/dev/null)",
    "submodules='^submodule\\..*\\.(path|ignore)$'",
    "for key in $(\"$git\" config --name-only --get-regexp \"$submodules\" 2>/dev/null) \\",
    "  $(\"$git\" config --file \"$top/.gitmodules\" --name-only --get-regexp \"$submodules\" 2>/dev/null) \\",
    "  $(\"$git\" config --blob :.gitmodules --name-only --get-regexp \"$submodules\" 2>/dev/null) \\",
    "  $(\"$git\" config --blob HEAD:.gitmodules --name-only --get-regexp \"$submodules\" 2>/dev/null); do",
    "  override \"${key%.*}.ignore\" all",
    "done",
    "export GIT_CONFIG_COUNT=$n",
    "exec \"$git\" \"$@\""
  ].join("\n") + "\n"

export const hostGitShim = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  realGit: string
): Effect.Effect<string, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function*() {
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "orc-git-" })
    const shim = path.join(dir, "git")
    yield* fs.writeFileString(shim, hostGitShimScript(realGit), { mode: 0o755 })
    return shim
  })

// Sandcastle spawns host git with the process env and finds it on the process PATH, so both have to name the shim while it runs.
export const withHostGitSafety = (hostGit: string) => <A, E>(use: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const safety = { ...hostGitSafetyEnv, PATH: hostGit.slice(0, hostGit.lastIndexOf("/")) + ":" + (Bun.env.PATH ?? "") }
      const saved = Object.keys(safety).map((name) => [name, Bun.env[name]] as const)
      Object.assign(Bun.env, safety)
      return saved
    }),
    () => use,
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of saved) {
          if (value === undefined) {
            delete Bun.env[name]
          } else {
            Bun.env[name] = value
          }
        }
      })
  )

export const resolvePiAgentDir = (
  fs: FileSystem.FileSystem,
  piSessionDir: string,
  configured: string | undefined
): Effect.Effect<Record<string, string>, NonoProviderError> =>
  Effect.gen(function*() {
    const dir = configured ?? `${piSessionDir}/agent`
    if (configured !== undefined) {
      const real = yield* fs.realPath(configured).pipe(
        Effect.mapError((cause) =>
          new NonoProviderError({ message: `orc nono provider: cannot resolve PI_CODING_AGENT_DIR ${configured}: ${String(cause)}` })
        )
      )
      if (!within(piSessionDir, real)) {
        return yield* new NonoProviderError({ message: `orc nono provider: PI_CODING_AGENT_DIR sits outside the session dir: ${configured}` })
      }
    }
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        new NonoProviderError({ message: `orc nono provider: cannot create the agent dir ${dir}: ${String(cause)}` })
      )
    )
    return { PI_CODING_AGENT_DIR: dir }
  })

export interface HostCommandResult {
  readonly stdout: string
  readonly stdoutBytes: Uint8Array
  readonly stderr: string
  readonly exitCode: number
}

export const runHostCommand = (
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
      (cause) => new NonoProviderError({ message: `orc nono provider: command failed to run: ${String(cause)}` })
    )
  )

// The caller's env PATH may name tools inside the copy, so a host binary is found on the host's own PATH.
export const resolveHostBinary = (fs: FileSystem.FileSystem, name: string): Effect.Effect<string, NonoProviderError> => {
  const found = Bun.which(name)
  return found === null
    ? Effect.fail(new NonoProviderError({ message: `orc nono provider: ${name} is not on the host PATH` }))
    : fs.realPath(found).pipe(
      Effect.mapError((cause) => new NonoProviderError({ message: `orc nono provider: cannot resolve ${name}: ${String(cause)}` }))
    )
}

export const resolveDeveloperDir = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  env: Record<string, string>
): Effect.Effect<string | null, NonoProviderError> =>
  process.platform !== "darwin" ? Effect.succeed(null) : Effect.gen(function*() {
    const xcodeSelect = yield* resolveHostBinary(fs, "xcode-select")
    const result = yield* runHostCommand(spawner, ChildProcess.make(xcodeSelect, ["-p"], { env, extendEnv: false }))
    if (result.exitCode !== 0) {
      return null
    }
    return yield* fs.realPath(result.stdout.trim()).pipe(
      Effect.mapError((cause) => new NonoProviderError({ message: `orc nono provider: cannot resolve the developer folder: ${String(cause)}` }))
    )
  })

// A mise shim is a link to mise itself, so it names no tool and the tool is looked for further along the PATH.
export const resolveRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  name: string,
  searchPath: string,
  home: string
): Effect.Effect<Runtime | null, NonoProviderError> =>
  Effect.gen(function*() {
    let shimmed = false
    for (const dir of searchPath.split(":").filter((entry) => path.isAbsolute(entry))) {
      const candidate = Bun.which(name, { PATH: dir })
      if (candidate === null) {
        continue
      }
      const real = yield* fs.realPath(candidate).pipe(
        Effect.mapError((cause) => new NonoProviderError({ message: `orc nono provider: cannot resolve ${name}: ${String(cause)}` }))
      )
      if (path.basename(real) === "mise") {
        shimmed = true
        continue
      }
      const runtime = runtimeOf(candidate, real, home)
      if (runtime === null) {
        return yield* new NonoProviderError({
          message: `orc nono provider: ${name} at ${real} is in neither a toolchain folder nor one mise install folder, so the sandbox is granted no folder for it`
        })
      }
      return runtime
    }
    if (shimmed) {
      return yield* new NonoProviderError({
        message: `orc nono provider: ${name} is on the PATH only as a mise shim; put its mise install folder on the PATH`
      })
    }
    return null
  })
