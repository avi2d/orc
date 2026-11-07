import { Effect, type FileSystem } from "effect"

const realOrNull = (fs: FileSystem.FileSystem, dir: string): Effect.Effect<string | null> =>
  fs.realPath(dir).pipe(Effect.orElseSucceed(() => null))

// Each pathspec is relative to projectDir, so git status must run with projectDir as its working folder.
export const nestedWorktreeExcludes = (
  fs: FileSystem.FileSystem,
  projectDir: string,
  porcelain: string
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function*() {
    const project = yield* realOrNull(fs, projectDir)
    if (project === null) {
      return []
    }
    const dirs = porcelain
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((dir) => dir !== "")
    const reals = yield* Effect.forEach(dirs, (dir) => realOrNull(fs, dir))
    return reals.flatMap((real) =>
      real !== null && real.startsWith(project + "/") ? [":(exclude,literal)" + real.slice(project.length + 1)] : []
    )
  })
