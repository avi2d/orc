import { Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/process"
import { pickEnv, sandboxedEnvNames } from "./agent-exec"
import { hostGitSafetyEnv, NonoProviderError, runHostCommand, type Spawner } from "./host"
import { credentialBearingKeys, includePathKeys, includeTargets, submoduleCheckouts } from "./git-config"
import { type NonoSandboxRoots, within } from "./nono-profile"

export const sandboxRuntimes: ReadonlyArray<string> = ["bun", "node", "pi"]

export const inheritedEnv = (hostEnv: Readonly<Record<string, string | undefined>>): Record<string, string> => pickEnv(hostEnv, sandboxedEnvNames)

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

export const sandboxEnv = (
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
export const refuseCredentialBearingCheckout = (
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
export const resolveRoots = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  hostGit: HostGit,
  worktree: string,
  piSessionDir: string,
  sessions: string
): Effect.Effect<NonoSandboxRoots, NonoProviderError | PlatformError> =>
  Effect.gen(function*() {
    for (const root of [worktree, piSessionDir, sessions]) {
      if (!path.isAbsolute(root)) {
        return yield* new NonoProviderError({ message: `orc nono provider: sandbox root must be absolute: ${root}` })
      }
    }
    const gitData = yield* resolveGitDataDir(spawner, path, hostGit, worktree)
    yield* fs.makeDirectory(piSessionDir, { recursive: true })
    yield* fs.makeDirectory(sessions, { recursive: true })
    return {
      worktree: yield* fs.realPath(worktree),
      gitData: yield* fs.realPath(gitData),
      piSessionDir: yield* fs.realPath(piSessionDir),
      sessions: yield* fs.realPath(sessions)
    }
  })

const NonoWhyVerdict = Schema.fromJsonString(Schema.Struct({ status: Schema.Literals(["allowed", "denied"]) }))

export const checkProfile = (
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
