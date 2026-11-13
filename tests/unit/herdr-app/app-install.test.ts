import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { herdrAppSourceDir, installApp, mergeKeys, readyBundledApp } from "../../../packages/run/src/features/installing-the-app/index"

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
    await writeFile(join(home, "keys.json"), "{}")
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
    await writeFile(join(home, "keys.json"), "{}")
    const result = await Effect.runPromise(installApp(source, home).pipe(Effect.flip, Effect.provide(BunServices.layer)))
    expect(result.detail).toContain("agents")
    expect(await readFile(join(home, "mods", "agents", "main.js"), "utf8")).toBe("personal")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not refuse a fresh checkout that has the sources but no build", async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-app-test-"))
  try {
    const bundled = join(root, "dist", "herdr-app")
    const home = join(root, "home")
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "keys.json"), "{}")
    const ready = await Effect.runPromise(readyBundledApp(herdrAppSourceDir(), bundled).pipe(Effect.provide(BunServices.layer)))
    const result = await Effect.runPromise(installApp(ready, home).pipe(Effect.provide(BunServices.layer)))
    expect(result.mods).toEqual(["orc-agents", "orc-board", "orc-resources", "orc-tabs"])
    expect(result.layouts).toEqual(["orc.json", "orc.svg"])
    expect(result.added).toEqual([
      { section: "layout:orc", key: "cmd-1" },
      { section: "layout:orc", key: "cmd-2" },
      { section: "layout:orc", key: "cmd-3" }
    ])
    expect((await readdir(join(home, "mods"))).sort()).toEqual(["orc-agents", "orc-board", "orc-resources", "orc-tabs"])
    expect((await readdir(join(home, "layouts"))).sort()).toEqual(["orc.json", "orc.svg"])
    const keys: unknown = JSON.parse(await readFile(join(home, "keys.json"), "utf8"))
    expect(keys).toEqual({
      "layout:orc": {
        "cmd-1": { command: "layout.select", args: { stack: "orc-views", child: "orc-board" } },
        "cmd-2": { command: "layout.select", args: { stack: "orc-views", child: "orc-resources" } },
        "cmd-3": { command: "layout.select", args: { stack: "orc-views", child: "orc-agents" } }
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("does not report an install when there is neither a build nor sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-app-test-"))
  try {
    const home = join(root, "home")
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "keys.json"), "{}")
    const ready = await Effect.runPromise(readyBundledApp(join(root, "no-sources"), join(root, "no-build")).pipe(Effect.provide(BunServices.layer)))
    const error = await Effect.runPromise(installApp(ready, home).pipe(Effect.flip, Effect.provide(BunServices.layer)))
    expect(error.detail).toContain("cannot read the built Herdr App files")
    expect(await readdir(home)).toEqual(["keys.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not install a build whose sources fail to compile", async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-app-test-"))
  try {
    const source = join(root, "source")
    await mkdir(join(source, "scripts"), { recursive: true })
    await mkdir(join(source, "mods", "orc-board"), { recursive: true })
    await mkdir(join(source, "layouts"), { recursive: true })
    await copyFile(join(herdrAppSourceDir(), "scripts", "build.ts"), join(source, "scripts", "build.ts"))
    await writeFile(join(source, "mods", "orc-board", "main.ts"), "export const = ;")
    await writeFile(join(source, "mods", "orc-board", "mod.json"), "{}")
    await writeFile(join(source, "layouts", "orc.json"), "{}")
    await writeFile(join(source, "keys.json"), "{}")
    const error = await Effect.runPromise(readyBundledApp(source, join(root, "dist")).pipe(Effect.flip, Effect.provide(BunServices.layer)))
    expect(error.detail).toContain("cannot build the Herdr App files")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
