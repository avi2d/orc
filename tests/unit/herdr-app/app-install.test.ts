import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { installApp, mergeKeys } from "../../../packages/run/src/app-install"

test("adds missing keys without replacing a person's binding", async () => {
  const ours = { "layout:orc": { "cmd-1": "orc-tabs.select:orc-board", "cmd-2": "orc-tabs.select:orc-resources" } }
  const result = await Effect.runPromise(mergeKeys({ "layout:orc": { "cmd-2": "tab.next" } }, ours).pipe(Effect.provide(BunServices.layer)))
  expect(result.keys).toEqual({ "layout:orc": { "cmd-1": "orc-tabs.select:orc-board", "cmd-2": "tab.next" } })
  expect(result.added).toEqual([{ section: "layout:orc", key: "cmd-1" }])
  expect(result.skipped).toEqual([{ section: "layout:orc", key: "cmd-2", kept: "tab.next" }])
})

test("installs only orc names without touching personal files", async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-app-test-"))
  try {
    const source = join(root, "source")
    const home = join(root, "home")
    await mkdir(join(source, "mods", "orc-board"), { recursive: true })
    await mkdir(join(source, "layouts"), { recursive: true })
    await mkdir(join(home, "mods", "agents"), { recursive: true })
    await writeFile(join(source, "mods", "orc-board", "main.js"), "orc")
    await writeFile(join(source, "layouts", "orc.json"), "{}")
    await writeFile(join(source, "keys.json"), "{}")
    await writeFile(join(home, "mods", "agents", "main.js"), "personal")
    await writeFile(join(home, "installed.json"), "personal")
    await Effect.runPromise(installApp(source, home).pipe(Effect.provide(BunServices.layer)))
    expect((await readdir(join(home, "mods"))).sort()).toEqual(["agents", "orc-board"])
    expect(await readdir(join(home, "layouts"))).toEqual(["orc.json"])
    expect(await readFile(join(home, "mods", "agents", "main.js"), "utf8")).toBe("personal")
    expect(await readFile(join(home, "installed.json"), "utf8")).toBe("personal")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses a foreign mod instead of overwriting the person's mod", async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-app-test-"))
  try {
    const source = join(root, "source")
    const home = join(root, "home")
    await mkdir(join(source, "mods", "agents"), { recursive: true })
    await mkdir(join(source, "layouts"), { recursive: true })
    await mkdir(join(home, "mods", "agents"), { recursive: true })
    await writeFile(join(source, "mods", "agents", "main.js"), "replacement")
    await writeFile(join(source, "keys.json"), "{}")
    await writeFile(join(home, "mods", "agents", "main.js"), "personal")
    const result = await Effect.runPromise(installApp(source, home).pipe(Effect.flip, Effect.provide(BunServices.layer)))
    expect(result.detail).toContain("agents")
    expect(await readFile(join(home, "mods", "agents", "main.js"), "utf8")).toBe("personal")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
