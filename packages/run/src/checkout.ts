import { Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { runGit } from "./git-run"
import { OrcRunError } from "./run-session"
import { nestedWorktreeExcludes } from "./worktree-excludes"

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

const exists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean, OrcRunError> =>
  fs.exists(path).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot stat " + path + ": " + String(cause) }))
  )

export interface Checkout {
  readonly git: string
  readonly projectDir: string
  readonly branch: string
}

export const parseRefuseMarkers = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")

export const openCheckout = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  cwd: string,
  branchName: string | undefined,
  runId: string,
  refuseMarkers: ReadonlyArray<string>
): Effect.Effect<Checkout, OrcRunError> =>
  Effect.gen(function*() {
    const top = yield* runGit(spawner, git, ["rev-parse", "--show-toplevel"], cwd)
    if (top.exitCode !== 0) {
      return yield* refuse("orc: " + cwd + " sits in no git checkout")
    }
    const projectDir = yield* fs.realPath(top.stdout.trim()).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot resolve the checkout: " + String(cause) }))
    )
    const candidates = refuseMarkers.flatMap((marker) => [path.join(projectDir, marker), path.join(path.dirname(projectDir), marker)])
    for (const candidate of candidates) {
      if (yield* exists(fs, candidate)) {
        return yield* refuse("orc: " + candidate + " marks this checkout as refused, so orc refuses to run in it")
      }
    }
    const listed = yield* runGit(spawner, git, ["worktree", "list", "--porcelain"], projectDir).pipe(
      Effect.map((result) => result.stdout),
      Effect.orElseSucceed(() => "")
    )
    const excludes = yield* nestedWorktreeExcludes(fs, projectDir, listed)
    const status = yield* runGit(spawner, git, ["status", "--porcelain", "--", ".", ...excludes], projectDir)
    if (status.exitCode !== 0) {
      return yield* refuse("orc: git status failed in " + projectDir)
    }
    const dirty = status.stdout.split("\n").filter((line) => line.trim() !== "").length
    if (dirty > 0) {
      return yield* refuse("orc: the checkout at " + projectDir + " holds " + dirty.toString() + " uncommitted changes, so commit or stash them before orc runs")
    }
    const branch = branchName ?? ("orc/" + runId)
    const named = yield* runGit(spawner, git, ["check-ref-format", "--branch", branch], projectDir)
    if (named.exitCode !== 0) {
      return yield* refuse("orc: " + branch + " is no usable branch name")
    }
    return { git, projectDir, branch }
  })
