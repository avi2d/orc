import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result } from "effect"
import { NonoProviderError, resolveRuntime } from "../../src/host"

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
