import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { closeTaskCopy, openTaskCopy, type TaskCopy } from "../../packages/run/src/task-copy"
import { git, withHome, withRepo } from "./run-helpers"

const gitBin = Bun.which("git") ?? "git"

const open = (projectDir: string, home: string, branch: string): Promise<TaskCopy | string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return yield* openTaskCopy(fs, path, spawner, gitBin, { projectDir: yield* fs.realPath(projectDir), branch }, home)
    }).pipe(
      Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message)),
      Effect.provide(BunServices.layer)
    )
  )

const close = (projectDir: string, copy: TaskCopy): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* closeTaskCopy(spawner, gitBin, projectDir, copy)
    }).pipe(Effect.provide(BunServices.layer))
  )

const opened = async (projectDir: string, home: string, branch: string): Promise<TaskCopy> => {
  const copy = await open(projectDir, home, branch)
  if (typeof copy === "string") {
    throw new Error(copy)
  }
  return copy
}

describe("task copies", () => {
  test("a new branch gets its copy under ORC_HOME instead of inside the project", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const copy = await opened(dir, home, "orc/test")
        expect(copy.dir).toBe(join(await realpath(home), "worktrees", basename(dir), "orc/test"))
        expect(git(copy.dir, ["branch", "--show-current"])).toBe("orc/test")
        expect(git(dir, ["status", "--porcelain"])).toBe("")
      })
    })
  })

  test("an existing branch is checked out at its tip instead of branching afresh from HEAD", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        git(dir, ["branch", "orc/test"])
        git(dir, ["commit", "-q", "--allow-empty", "-m", "later on main"])
        const copy = await opened(dir, home, "orc/test")
        expect(git(copy.dir, ["rev-parse", "HEAD"])).toBe(git(dir, ["rev-parse", "orc/test"]))
        expect(git(copy.dir, ["rev-parse", "HEAD"])).not.toBe(git(dir, ["rev-parse", "HEAD"]))
      })
    })
  })

  test("a branch checked out in an old sandcastle copy is reused with its uncommitted work instead of refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const old = join(dir, ".sandcastle", "worktrees", "orc-test")
        git(dir, ["worktree", "add", "-q", "-b", "orc/test", old])
        await writeFile(join(old, "unsaved.txt"), "work in progress\n")
        const copy = await opened(dir, home, "orc/test")
        expect(copy.dir).toBe(await realpath(old))
        expect(await Bun.file(join(old, "unsaved.txt")).text()).toBe("work in progress\n")
      })
    })
  })

  test("a copy whose folder was deleted is made again instead of refused as checked out", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const first = await opened(dir, home, "orc/test")
        await Bun.$`rm -rf ${first.dir}`.quiet()
        const again = await opened(dir, home, "orc/test")
        expect(again.dir).toBe(first.dir)
        expect(existsSync(join(again.dir, "seed.txt"))).toBe(true)
      })
    })
  })

  test("the project checkout holding the branch itself is refused instead of shared", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        git(dir, ["checkout", "-q", "-b", "orc/test"])
        expect(await open(dir, home, "orc/test")).toContain("checked out itself")
      })
    })
  })

  test("a foreign folder at the copy's place is refused instead of overwritten", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const place = join(home, "worktrees", basename(dir), "orc/test")
        await mkdir(place, { recursive: true })
        await writeFile(join(place, "keep.txt"), "mine\n")
        expect(await open(dir, home, "orc/test")).toContain("already exists")
        expect(await Bun.file(join(place, "keep.txt")).text()).toBe("mine\n")
      })
    })
  })

  test("closing a copy with uncommitted work keeps it instead of removing it", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const copy = await opened(dir, home, "orc/test")
        await writeFile(join(copy.dir, "unsaved.txt"), "work in progress\n")
        await close(dir, copy)
        expect(await Bun.file(join(copy.dir, "unsaved.txt")).text()).toBe("work in progress\n")
      })
    })
  })

  test("closing a clean copy orc made removes it and keeps its commits instead of leaving the folder", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const copy = await opened(dir, home, "orc/test")
        await writeFile(join(copy.dir, "work.txt"), "work\n")
        git(copy.dir, ["add", "work.txt"])
        git(copy.dir, ["commit", "-qm", "work"])
        const head = git(copy.dir, ["rev-parse", "HEAD"])
        await close(dir, copy)
        expect(existsSync(copy.dir)).toBe(false)
        expect(git(dir, ["rev-parse", "orc/test"])).toBe(head)
      })
    })
  })

  test("closing a clean copy found outside orc's folders leaves it instead of removing someone else's checkout", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const elsewhere = join(home, "lane")
        git(dir, ["worktree", "add", "-q", "-b", "orc/test", elsewhere])
        const copy = await opened(dir, home, "orc/test")
        await close(dir, copy)
        expect(existsSync(join(elsewhere, "seed.txt"))).toBe(true)
      })
    })
  })
})
