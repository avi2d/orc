import { Console, Effect, type FileSystem, type Path } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { collectOutput, runGit } from "./git-run"
import { OrcRunError } from "./run-session"

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

export interface TaskCopy {
  readonly dir: string
  readonly removable: boolean
}

interface ListedCopy {
  readonly dir: string
  readonly branch: string | null
  readonly missing: boolean
}

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

const parseWorktreeList = (porcelain: string): ReadonlyArray<ListedCopy> =>
  porcelain.split("\n\n").flatMap((block) => {
    const lines = block.split("\n")
    const dir = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length)
    const missing = lines.some((line) => line.startsWith("prunable"))
    return dir === undefined ? [] : [{ dir, branch: ref?.startsWith("refs/heads/") === true ? ref.slice("refs/heads/".length) : null, missing }]
  })

// Two checkouts can share a folder name, so the real path's hash keeps their copies apart.
const taskCopyDir = (path: Path.Path, home: string, realProjectDir: string, branch: string): string =>
  path.join(home, "worktrees", path.basename(realProjectDir) + "-" + new Bun.CryptoHasher("sha256").update(realProjectDir).digest("hex").slice(0, 8), branch)

const gitOrRefuse = (spawner: Spawner, git: string, args: ReadonlyArray<string>, cwd: string, action: string) =>
  runGit(spawner, git, args, cwd).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Effect.succeed(result.stdout) : refuse("orc: cannot " + action + ": " + result.stderr.trim()))
  )

const realPathOf = (fs: FileSystem.FileSystem, dir: string): Effect.Effect<string, OrcRunError> =>
  fs.realPath(dir).pipe(Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot resolve " + dir + ": " + String(cause) })))

// Only the folders orc's own runs made copies in are swept; a copy found anywhere else belongs to someone else.
const madeByOrc = (path: Path.Path, home: string, dir: string): boolean =>
  dir.startsWith(path.join(home, "worktrees") + "/")

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
    const realProjectDir = yield* realPathOf(fs, projectDir)
    const listed = parseWorktreeList(yield* gitOrRefuse(spawner, git, ["worktree", "list", "--porcelain"], projectDir, "list the copies of " + projectDir))
    const existing = listed.find((copy) => copy.branch === branch)
    // A global prune would also clear other tools' worktrees whose folders are briefly away, so only this branch's stale entry goes.
    if (existing?.missing === true) {
      yield* gitOrRefuse(spawner, git, ["worktree", "remove", existing.dir], projectDir, "clear the copy of " + branch + " whose folder " + existing.dir + " is gone")
    } else if (existing !== undefined) {
      const dir = yield* realPathOf(fs, existing.dir)
      if (dir === realProjectDir) {
        return yield* refuse("orc: " + projectDir + " has " + branch + " checked out itself, and git checks a branch out in one place only, so switch the checkout to another branch")
      }
      yield* Console.log("orc: reusing the copy of " + branch + " at " + dir)
      return { dir, removable: madeByOrc(path, realHome, dir) }
    }
    const dir = taskCopyDir(path, realHome, realProjectDir, branch)
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

// runGit hides the operator's global config, where the identity usually lives; reading a key runs no repository program.
const hostIdentity = (spawner: Spawner, realGit: string, projectDir: string, key: string): Effect.Effect<string> =>
  Effect.scoped(spawner.spawn(ChildProcess.make(realGit, ["config", "--get", key], { cwd: projectDir })).pipe(
    Effect.flatMap(collectOutput),
    Effect.map((result) => result.exitCode === 0 ? result.stdout.trim() : "")
  )).pipe(Effect.orElseSucceed(() => ""))

// The agent's git reads this file as its global config, so commits in the copy carry the operator's identity without the operator's other settings.
export const writeAgentGitConfig = (
  spawner: Spawner,
  git: string,
  realGit: string,
  projectDir: string,
  copyDir: string,
  file: string
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const write = (args: ReadonlyArray<string>) => gitOrRefuse(spawner, git, ["config", "--file", file, ...args], projectDir, "write the agent's git config " + file)
    yield* write(["--replace-all", "safe.directory", copyDir])
    for (const key of ["user.name", "user.email"]) {
      const value = yield* hostIdentity(spawner, realGit, projectDir, key)
      if (value !== "") {
        yield* write([key, value])
      }
    }
  })
