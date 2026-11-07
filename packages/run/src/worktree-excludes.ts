import { Effect, type FileSystem } from "effect"

export const nestedWorktreeExcludes = (
  fs: FileSystem.FileSystem,
  projectDir: string,
  porcelain: string
): Effect.Effect<ReadonlyArray<string>, never, never> =>
  Effect.gen(function*() {
    const specs: Array<string> = []
    const dirs = porcelain
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((dir) => dir !== "")
    for (const dir of dirs) {
      const real = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => null))
      if (real === null) {
        continue
      }
      if (real === projectDir) {
        continue
      }
      if (!real.startsWith(projectDir + "/")) {
        continue
      }
      specs.push(":(exclude,top)" + real.slice(projectDir.length + 1))
    }
    return specs
  })
