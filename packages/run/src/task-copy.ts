import { Console, Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { runGit } from "./git-run"
import { OrcRunError } from "./run-session"

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

export interface TaskCopy {
  readonly dir: string
  readonly removable: boolean
}

interface ListedCopy {
  readonly dir: string
  readonly branch: string | null
}

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

export const parseWorktreeList = (porcelain: string): ReadonlyArray<ListedCopy> =>
  porcelain.split("\n\n").flatMap((block) => {
    const lines = block.split("\n")
    const dir = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length)
    return dir === undefined ? [] : [{ dir, branch: ref?.startsWith("refs/heads/") === true ? ref.slice("refs/heads/".length) : null }]
  })

export const taskCopyDir = (path: Path.Path, home: string, projectDir: string, branch: string): string =>
  path.join(home, "worktrees", path.basename(projectDir), branch)

const gitOrRefuse = (spawner: Spawner, git: string, args: ReadonlyArray<string>, cwd: string, action: string) =>
  runGit(spawner, git, args, cwd).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Effect.succeed(result.stdout) : refuse("orc: cannot " + action + ": " + result.stderr.trim()))
  )

const realPathOf = (fs: FileSystem.FileSystem, dir: string): Effect.Effect<string, OrcRunError> =>
  fs.realPath(dir).pipe(Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot resolve " + dir + ": " + String(cause) })))

// Only the folders orc's own runs made copies in are swept; a copy found anywhere else belongs to someone else.
const madeByOrc = (path: Path.Path, home: string, projectDir: string, dir: string): boolean =>
  [path.join(home, "worktrees"), path.join(projectDir, ".sandcastle", "worktrees")].some((root) => dir.startsWith(root + "/"))

export const openTaskCopy = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  git: string,
  checkout: { readonly projectDir: string; readonly branch: string },
  home: string
): Effect.Effect<TaskCopy, OrcRunError> =>
  Effect.gen(function*() {
    const { projectDir, branch } = checkout
    const copies = path.join(home, "worktrees")
    yield* fs.makeDirectory(copies, { recursive: true }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the copies folder " + copies + ": " + String(cause) }))
    )
    const realHome = path.dirname(yield* realPathOf(fs, copies))
    yield* gitOrRefuse(spawner, git, ["worktree", "prune"], projectDir, "prune the copies whose folders are gone")
    const listed = parseWorktreeList(yield* gitOrRefuse(spawner, git, ["worktree", "list", "--porcelain"], projectDir, "list the copies of " + projectDir))
    const existing = listed.find((copy) => copy.branch === branch)
    if (existing !== undefined) {
      const dir = yield* realPathOf(fs, existing.dir)
      if (dir === projectDir) {
        return yield* refuse("orc: " + projectDir + " has " + branch + " checked out itself, and git checks a branch out in one place only, so switch the checkout to another branch")
      }
      yield* Console.log("orc: reusing the copy of " + branch + " at " + dir)
      return { dir, removable: madeByOrc(path, realHome, projectDir, dir) }
    }
    const dir = taskCopyDir(path, realHome, projectDir, branch)
    if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => true))) {
      return yield* refuse("orc: " + dir + " already exists and is no copy of " + projectDir + ", so orc leaves it alone; move it aside and rerun")
    }
    yield* fs.makeDirectory(path.dirname(dir), { recursive: true }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the folder for the copy " + dir + ": " + String(cause) }))
    )
    const known = yield* runGit(spawner, git, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch], projectDir)
    yield* gitOrRefuse(spawner, git, known.exitCode === 0 ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"], projectDir, "add a copy of " + branch + " at " + dir)
    return { dir, removable: true }
  })

export const closeTaskCopy = (spawner: Spawner, git: string, projectDir: string, copy: TaskCopy): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const status = yield* gitOrRefuse(spawner, git, ["status", "--porcelain"], copy.dir, "read the status of the copy " + copy.dir)
    const changes = status.split("\n").filter((line) => line.trim() !== "").length
    if (changes > 0) {
      yield* Console.log("orc: kept the copy at " + copy.dir + ", which holds " + changes.toString() + (changes === 1 ? " uncommitted change" : " uncommitted changes"))
      return
    }
    if (!copy.removable) {
      return
    }
    yield* gitOrRefuse(spawner, git, ["worktree", "remove", copy.dir], projectDir, "remove the copy " + copy.dir)
  })
