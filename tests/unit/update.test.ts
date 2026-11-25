import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { readOrcConfig } from "../../packages/run/src/shared/config/index"
import { formatUpdate, installCommand, isNewer, registryOf, runUpdate } from "../../packages/run/src/features/updating-orc/index"
import { launcherDirectory } from "../../packages/run/src/features/updating-orc/launcher-release"

const root = mkdtempSync(join(tmpdir(), "orc-update-"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

let homes = 0

const homeWith = (config: unknown): string => {
  homes += 1
  const home = join(root, String(homes))
  mkdirSync(home)
  writeFileSync(join(home, "config.json"), JSON.stringify(config))
  return home
}

const decoded = (home: string) =>
  Effect.runPromise(readOrcConfig(home).pipe(
    Effect.map((config) => ({ ok: true as const, command: config.update?.command })),
    Effect.catchTag("ConfigError", (error) => Effect.succeed({ ok: false as const, detail: error.detail })),
    Effect.provide(BunServices.layer)
  ))

describe("isNewer", () => {
  test("a higher major, minor or patch is newer", () => {
    expect(isNewer("1.0.0", "0.17.0")).toBe(true)
    expect(isNewer("0.18.0", "0.17.0")).toBe(true)
    expect(isNewer("0.17.1", "0.17.0")).toBe(true)
  })

  test("versions compare by number, not by text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
    expect(isNewer("0.9.0", "0.10.0")).toBe(false)
  })

  test("an equal or older version is not newer", () => {
    expect(isNewer("0.17.0", "0.17.0")).toBe(false)
    expect(isNewer("0.16.3", "0.17.0")).toBe(false)
  })

  test("a release is newer than its prerelease", () => {
    expect(isNewer("0.18.0", "0.18.0-rc.1")).toBe(true)
    expect(isNewer("0.18.0-rc.1", "0.18.0")).toBe(false)
  })
})

describe("installCommand", () => {
  test("with no update.command, bun installs the found version globally", () => {
    expect(installCommand(undefined, "0.18.0")).toEqual(["bun", "add", "-g", "@avi2dg/orc@0.18.0"])
  })

  test("update.command runs as given, with {version} replaced by the found version", () => {
    expect(installCommand(["sh", "-c", "cd ~/orc && git pull", "v{version}"], "0.18.0")).toEqual(["sh", "-c", "cd ~/orc && git pull", "v0.18.0"])
  })
})

describe("registryOf", () => {
  test("defaults to the npm registry and takes npm_config_registry without its trailing slash", () => {
    expect(registryOf({})).toBe("https://registry.npmjs.org")
    expect(registryOf({ npm_config_registry: "http://127.0.0.1:4873/" })).toBe("http://127.0.0.1:4873")
  })
})

describe("update.command in config.json", () => {
  test("decodes a command as a list of words", async () => {
    expect(await decoded(homeWith({ providers: [], update: { command: ["bun", "link"] } }))).toEqual({ ok: true, command: ["bun", "link"] })
  })

  test("leaves the command unset when update is absent", async () => {
    expect(await decoded(homeWith({ providers: [] }))).toEqual({ ok: true, command: undefined })
  })

  test("refuses a command given as one string, an empty list or an unknown key", async () => {
    const refused = await Promise.all([
      decoded(homeWith({ providers: [], update: { command: "bun link" } })),
      decoded(homeWith({ providers: [], update: { command: [] } })),
      decoded(homeWith({ providers: [], update: { command: ["bun"], when: "always" } }))
    ])
    expect(refused.map((result) => result.ok)).toEqual([false, false, false])
  })
})

describe("launcher updates", () => {
  test("recognises both source and compiled entries without mistaking another path for a launcher", async () => {
    const home = join(root, "launcher-layouts")
    const directory = join(home, ".local/share/orc")
    const release = join(directory, "v1.2.3")
    const source = join(release, "packages/run/src/bin.ts")
    const binary = join(release, "orc")
    mkdirSync(join(release, "packages/run/src"), { recursive: true })
    writeFileSync(source, "")
    writeFileSync(binary, "")
    const detect = (entry: string, compiled: boolean) =>
      Effect.runPromise(launcherDirectory(home, entry, "1.2.3", compiled).pipe(Effect.provide(BunServices.layer)))
    expect(await detect(realpathSync(source), false)).toBe(directory)
    expect(await detect(realpathSync(binary), true)).toBe(directory)
    expect(await detect(realpathSync(binary), false)).toBeNull()
    expect(await detect(realpathSync(source), true)).toBeNull()
  })

  test("a compiled launcher selects a release instead of running bun add -g", async () => {
    const home = join(root, "compiled-home")
    const directory = join(home, ".local/share/orc")
    const running = join(directory, "v1.0.0/orc")
    const next = join(directory, "v99.0.0/orc")
    mkdirSync(join(directory, "v1.0.0"), { recursive: true })
    mkdirSync(join(directory, "v99.0.0"), { recursive: true })
    writeFileSync(running, "")
    writeFileSync(next, '#!/bin/sh\nprintf "orc 99.0.0\\n"\n')
    chmodSync(next, 0o755)
    writeFileSync(join(directory, "release"), "1.0.0\n")
    const bin = join(home, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 97\n")
    chmodSync(join(bin, "bun"), 0o755)
    const path = process.env.PATH
    process.env.PATH = bin + ":" + (path ?? "")
    const registry = Bun.serve({ port: 0, fetch: () => Response.json({ version: "99.0.0" }) })
    try {
      const result = await Effect.runPromise(runUpdate({
        home: join(root, "no-config"),
        env: { HOME: home, npm_config_registry: registry.url.href },
        running: "1.0.0",
        main: "/$bunfs/root/orc",
        executable: running
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result.outcome).toBe("installed")
      expect(readFileSync(join(directory, "release"), "utf8")).toBe("99.0.0\n")
    } finally {
      await registry.stop(true)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  })
})

describe("formatUpdate", () => {
  test("a failure names the version kept, the reason and the installer's output", () => {
    const text = formatUpdate({ schema: "orc.update.v1", found: "0.18.0", running: "0.17.0", outcome: "failed", detail: "bun add -g @avi2dg/orc@0.18.0 exited 1", output: "error: no network" })
    expect(text).toBe("orc update stayed on 0.17.0: bun add -g @avi2dg/orc@0.18.0 exited 1\nerror: no network")
  })
})
