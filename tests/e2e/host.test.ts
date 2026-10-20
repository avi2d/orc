import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result } from "effect"
import { hostGitShimScript, NonoProviderError, resolveRuntime } from "../../src/host"

const runtimeAt = (name: string, searchPath: string, home: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* resolveRuntime(yield* FileSystem.FileSystem, yield* Path.Path, name, searchPath, home)
    }).pipe(Effect.provide(BunServices.layer), Effect.result)
  )

const withRuntimeHome = async (use: (home: string, installs: string) => Promise<void>) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "orc-nono-runtime-")))
  try {
    const installs = join(home, ".local", "share", "mise", "installs")
    await mkdir(join(home, ".local", "bin"), { recursive: true })
    await mkdir(join(home, ".local", "share", "mise", "shims"), { recursive: true })
    await writeFile(join(home, ".local", "bin", "mise"), "#!/bin/sh\n", { mode: 0o755 })
    await use(home, installs)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const installProgram = async (file: string) => {
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, "#!/bin/sh\n", { mode: 0o755 })
}

describe("resolveRuntime", () => {
  test("follows mise's shims past to the install folder, never to the shim or mise itself", async () => {
    await withRuntimeHome(async (home, installs) => {
      const shims = join(home, ".local", "share", "mise", "shims")
      const install = join(installs, "bun", "9.9.9")
      await symlink(join(home, ".local", "bin", "mise"), join(shims, "bun"))
      await installProgram(join(install, "bin", "bun"))
      const result = await runtimeAt("bun", `${shims}:${join(install, "bin")}`, home)
      expect(result).toEqual(Result.succeed({ binDir: join(install, "bin"), installDir: install }))
    })
  })

  test("keeps an npm bin link whose target is cli.js, granting the package's mise version folder", async () => {
    await withRuntimeHome(async (home, installs) => {
      const node = join(installs, "node", "9.9.9")
      const cli = join(node, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
      await installProgram(cli)
      await mkdir(join(node, "bin"))
      await symlink("../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", join(node, "bin", "pi"))
      const result = await runtimeAt("pi", join(node, "bin"), home)
      expect(result).toEqual(Result.succeed({ binDir: join(node, "bin"), installDir: node }))
    })
  })

  test("refuses an npm bin link under a home prefix instead of guessing its folder", async () => {
    await withRuntimeHome(async (home) => {
      const prefix = join(home, ".npm-global")
      await installProgram(join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"))
      await mkdir(join(prefix, "bin"))
      await symlink("../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", join(prefix, "bin", "pi"))
      const result = await runtimeAt("pi", join(prefix, "bin"), home)
      expect(Result.isFailure(result) && result.failure instanceof NonoProviderError).toBe(true)
    })
  })

  test("refuses a runtime in a home bin folder", async () => {
    await withRuntimeHome(async (home) => {
      await installProgram(join(home, "bin", "bun"))
      const result = await runtimeAt("bun", join(home, "bin"), home)
      expect(Result.isFailure(result) && result.failure instanceof NonoProviderError).toBe(true)
    })
  })

  test("refuses a runtime the PATH reaches only through a mise shim", async () => {
    await withRuntimeHome(async (home) => {
      const shims = join(home, ".local", "share", "mise", "shims")
      await symlink(join(home, ".local", "bin", "mise"), join(shims, "bun"))
      const result = await runtimeAt("bun", shims, home)
      expect(Result.isFailure(result) && result.failure instanceof NonoProviderError).toBe(true)
    })
  })

  test("finds nothing when no folder on the PATH holds the runtime", async () => {
    expect(await runtimeAt("bun", "/nonexistent-orc-bin", "/nonexistent-orc-home")).toEqual(Result.succeed(null))
  })
})

const withShimRepo = async (keys: Record<string, string>, use: (shim: string, dir: string) => Promise<void>): Promise<void> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orc-git-shim-")))
  try {
    const realGit = Bun.which("git") ?? "git"
    const shim = join(dir, "git")
    await writeFile(shim, hostGitShimScript(realGit), { mode: 0o755 })
    const init = Bun.spawnSync([realGit, "init", "-q", dir])
    expect(init.exitCode).toBe(0)
    for (const [key, value] of Object.entries(keys)) {
      const set = Bun.spawnSync([realGit, "config", key, value], { cwd: dir })
      expect(set.exitCode).toBe(0)
    }
    await use(shim, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const shimEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
})

describe("hostGitShim", () => {
  test("lets the gate keys no-mistakes writes into a worktree pass", async () => {
    await withShimRepo({ "receive.advertisePushOptions": "true", "core.hooksPath": "/tmp/orc-evil-hooks" }, async (shim, dir) => {
      const result = Bun.spawnSync([shim, "rev-parse", "--is-bare-repository"], { cwd: dir, env: shimEnv() })
      expect(result.exitCode).toBe(0)
    })
  })

  test("refuses a credential helper the sandbox writes into a worktree", async () => {
    await withShimRepo({ "credential.helper": "store" }, async (shim, dir) => {
      const result = Bun.spawnSync([shim, "rev-parse", "--is-bare-repository"], { cwd: dir, env: shimEnv() })
      expect(result.exitCode).toBe(97)
      expect(result.stderr.toString()).toContain("only config that runs no program")
    })
  })
})
