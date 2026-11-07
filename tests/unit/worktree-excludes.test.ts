import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import { nestedWorktreeExcludes } from "../../packages/run/src/worktree-excludes"

const excludesFor = (projectDir: string, porcelain: string): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* nestedWorktreeExcludes(fs, projectDir, porcelain)
    }).pipe(Effect.provide(BunServices.layer))
  )

const withLinkedProject = async (use: (linked: string, real: string) => Promise<void>): Promise<void> => {
  const realBase = await mkdtemp(join(tmpdir(), "orc-excludes-real-"))
  const linkBase = await mkdtemp(join(tmpdir(), "orc-excludes-link-"))
  const real = await realpath(realBase)
  const linked = join(linkBase, "project")
  await symlink(real, linked)
  try {
    await mkdir(join(real, ".old", "copy"), { recursive: true })
    await mkdir(join(real, "sub"), { recursive: true })
    await use(linked, real)
  } finally {
    await rm(linkBase, { recursive: true, force: true })
    await rm(realBase, { recursive: true, force: true })
  }
}

test("a project reached through a symlink still leaves out its registered nested worktree instead of counting it as dirt", async () => {
  await withLinkedProject(async (linked, real) => {
    expect(linked).not.toBe(real)
    const porcelain = "worktree " + real + "\nHEAD 0\nbranch refs/heads/main\n\nworktree " + join(real, ".old", "copy") + "\nHEAD 0\nbranch refs/heads/old\n"
    expect(await excludesFor(linked, porcelain)).toEqual([":(exclude,literal).old/copy"])
  })
})

test("a project folder below the repository top names the nested worktree relative to itself instead of the top", async () => {
  await withLinkedProject(async (linked, real) => {
    await mkdir(join(real, "sub", "copy"), { recursive: true })
    const porcelain = "worktree " + real + "\n\nworktree " + join(real, "sub", "copy") + "\n\nworktree " + join(real, ".old", "copy") + "\n"
    expect(await excludesFor(join(linked, "sub"), porcelain)).toEqual([":(exclude,literal)copy"])
  })
})
