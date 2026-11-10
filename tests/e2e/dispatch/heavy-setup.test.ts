import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import { detectWrap } from "../../../packages/run/src/dispatch/heavy-standin"
import { readHeavySettings, writeHeavyBin } from "../../../packages/run/src/dispatch/heavy-setup"

const runEffect = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

describe("the heavy queue setup", () => {
  test("the macOS wrapper applies on darwin under auto, and nowhere else", () => {
    expect(detectWrap("darwin", "auto")).toBe("taskpolicy -c utility")
    expect(detectWrap("darwin", "none")).toBe("")
    expect(detectWrap("linux", "auto")).toBe("")
    expect(detectWrap("other", "auto")).toBe("")
  })

  test("an empty home resolves the public defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-heavy-home-"))
    try {
      const settings = await runEffect(Effect.provide(readHeavySettings(home), BunServices.layer))
      expect(settings).toEqual({ group: "heavy", commands: [], limit: "auto" })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the home config names the group, the extra commands and the limit", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-heavy-home-"))
    try {
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ providers: [], heavy: { group: "g", commands: ["tool"], limit: "none" } })
      )
      const settings = await runEffect(Effect.provide(readHeavySettings(home), BunServices.layer))
      expect(settings).toEqual({ group: "g", commands: ["tool"], limit: "none" })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a stale stand-in leaves the bin dir on the next write", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-heavy-bin-"))
    try {
      const first = await runEffect(
        Effect.provide(
          writeHeavyBin(home, { group: "heavy", commands: ["tool"], limit: "auto" }, "linux"),
          BunServices.layer
        )
      )
      expect(first).toContain("tool")
      const second = await runEffect(
        Effect.provide(
          writeHeavyBin(home, { group: "heavy", commands: [], limit: "auto" }, "linux"),
          BunServices.layer
        )
      )
      expect(second).not.toContain("tool")
      expect(await Bun.file(join(home, "heavy", "bin", "tool")).exists()).toBe(false)
      expect(await Bun.file(join(home, "heavy", "bin", "bun")).exists()).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("every generated stand-in passes the shell syntax check and runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-heavy-bin-"))
    try {
      const tools = await runEffect(
        Effect.provide(
          writeHeavyBin(home, { group: "heavy", commands: ["tool"], limit: "auto" }, "linux"),
          BunServices.layer
        )
      )
      expect(tools).toContain("bun")
      expect(tools).toContain("xcodebuild")
      expect(tools).toContain("tool")
      for (const tool of tools) {
        const check = Bun.spawnSync(["sh", "-n", join(home, "heavy", "bin", tool)])
        expect(check.exitCode).toBe(0)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
