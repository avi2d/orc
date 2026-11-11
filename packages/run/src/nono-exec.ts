import { Effect, FileSystem, Path, type Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import { agentEnv, type AgentExec } from "./agent-exec"
import { standinDirSuffix } from "./standin-dir"
import { NonoProviderError, prepareSandboxShims, resolveDeveloperDir, resolveHostBinary, resolvePiAgentDir, resolveRuntime } from "./host"
import { buildHostGitEnv, checkProfile, refuseCredentialBearingCheckout, resolveRoots, sandboxEnv, sandboxRuntimes } from "./nono"
import { defaultToolchainResolver, selectNonoProfile, type ModelCredential, type ToolchainResolver } from "./nono-profile"

export interface NonoExecOptions {
  readonly worktree: string
  readonly piSessionDir: string
  readonly sessionsDir: string
  readonly piAgentDir?: string | undefined
  readonly modelCredential?: ModelCredential | undefined
  readonly hostEnv: Readonly<Record<string, string | undefined>>
  readonly toolchain?: ToolchainResolver | undefined
  readonly env: Readonly<Record<string, string>>
}

export const checksCacheReads = (
  path: Path.Path,
  hostEnv: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> =>
  hostEnv.HOME === undefined || hostEnv.HOME === "" ? [] : [path.join(hostEnv.HOME, ".cache", "avi2dg-checks")]

const runtimeSearchPath = (searchPath: string): string =>
  searchPath.split(":").filter((entry) => !entry.endsWith(standinDirSuffix)).join(":")

export type NonoExec = Extract<AgentExec, { readonly kind: "nono" }>

export const openNonoExec = (
  options: NonoExecOptions
): Effect.Effect<NonoExec, NonoProviderError | PlatformError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const hostEnv = options.hostEnv
    const hostGit = { binary: yield* resolveHostBinary(fs, "git"), env: buildHostGitEnv(hostEnv) }
    const roots = yield* resolveRoots(spawner, fs, path, hostGit, options.worktree, options.piSessionDir, options.sessionsDir)
    yield* refuseCredentialBearingCheckout(spawner, fs, path, roots, hostGit)
    const toolchain = options.toolchain ?? defaultToolchainResolver(homedir())
    const runtimes = (yield* Effect.forEach(sandboxRuntimes, (name) => resolveRuntime(fs, path, name, runtimeSearchPath(hostEnv.PATH ?? ""), toolchain))).filter((runtime) => runtime !== null)
    const agentDir = yield* resolvePiAgentDir(fs, roots.piSessionDir, options.piAgentDir)
    const shims = yield* prepareSandboxShims(fs, path, roots.piSessionDir)
    yield* Effect.addFinalizer(() => fs.remove(shims.shimDir, { recursive: true }).pipe(Effect.result))
    const sandboxed = sandboxEnv(hostEnv, roots.piSessionDir, [shims.shimDir, ...runtimes.map((runtime) => runtime.binDir)], agentDir)
    const env = agentEnv(sandboxed, options.env)
    const runtimeDirs = runtimes.flatMap((runtime) => runtime.installDir === null ? [] : [runtime.installDir])
    const developerDir = yield* resolveDeveloperDir(spawner, fs, sandboxed)
    const nonoBinary = yield* resolveHostBinary(fs, "nono")
    const nono = (args: ReadonlyArray<string>) => ChildProcess.make(nonoBinary, args, { env, extendEnv: false })
    const profileDir = yield* fs.makeTempDirectoryScoped({ prefix: "orc-nono-" })
    const profilePath = path.join(profileDir, "profile.json")
    const profile = yield* selectNonoProfile(roots, { developerDir, toolchainFolders: [...toolchain.folders, ...checksCacheReads(path, hostEnv)], runtimeDirs }, options.modelCredential)
    yield* fs.writeFileString(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
    yield* checkProfile(spawner, nono, profilePath, [profileDir, nonoBinary, path.dirname(nonoBinary)])
    yield* fs.makeDirectory(sandboxed.TMPDIR, { recursive: true })
    return { kind: "nono", cwd: roots.worktree, env, nonoBinary, profilePath } as const
  })
