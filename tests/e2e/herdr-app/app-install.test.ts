import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { herdrAppSourceDir, installApp, readyBundledApp } from "../../../packages/run/src/features/installing-the-app/index"

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
