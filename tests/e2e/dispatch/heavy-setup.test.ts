import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { startHeavyWatch } from "../../../packages/run/src/dispatch/heavy-cli"
import { detectWrap } from "../../../packages/run/src/dispatch/heavy-standin"
import { readHeavySettings, writeHeavyBin } from "../../../packages/run/src/dispatch/heavy-setup"
import { checkHeavy, watchOnce } from "../../../packages/run/src/dispatch/heavy-watch"

const runEffect = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const loggingPueue = `#!/bin/sh
echo "pueue $*" >> "$FAKE_PUEUE_LOG"
case "$1" in
  group) echo '{}';;
  add) echo 9;;
  status) echo '{"tasks":{},"groups":{}}';;
esac
exit 0
`

const holderHome = async (through: ReadonlyArray<string> | null, limit: "auto" | "none" = "none"): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "orc-heavy-through-home-"))
  await mkdir(join(home, "fake"), { recursive: true })
  await writeFile(join(home, "fake", "pueue"), loggingPueue, { mode: 0o755 })
  const heavy = through === null ? {} : { through }
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: [], heavy: { ...heavy, limit } }))
  return home
}

const withLoggingPueue = async <A>(home: string, fn: () => Promise<A>): Promise<A> => {
  const path = process.env.PATH ?? ""
  const savedLog = process.env.FAKE_PUEUE_LOG
  const savedBypass = process.env.HEAVY_QUEUE_BYPASS
  process.env.PATH = join(home, "fake") + ":" + path
  process.env.FAKE_PUEUE_LOG = join(home, "pueue.log")
  delete process.env.HEAVY_QUEUE_BYPASS
  try {
    return await fn()
  } finally {
    process.env.PATH = path
    if (savedLog === undefined) {
      delete process.env.FAKE_PUEUE_LOG
    } else {
      process.env.FAKE_PUEUE_LOG = savedLog
    }
    if (savedBypass !== undefined) {
      process.env.HEAVY_QUEUE_BYPASS = savedBypass
    }
  }
}

const pueueCalls = (home: string): Promise<string> => readFile(join(home, "pueue.log"), "utf8").catch(() => "")

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
      expect(settings).toEqual({ group: "heavy", commands: [], limit: "auto", through: null })
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
      expect(settings).toEqual({ group: "g", commands: ["tool"], limit: "none", through: null })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the home config names the through command word by word", async () => {
    const home = await holderHome(["winbox-heavy", "run", "--"])
    try {
      const settings = await runEffect(readHeavySettings(home))
      expect(settings.through).toEqual(["winbox-heavy", "run", "--"])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("an empty through list is refused instead of read as no through command", async () => {
    const home = await holderHome([])
    try {
      const failure = await runEffect(Effect.flip(readHeavySettings(home)))
      expect(failure.detail).toContain("config.json")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("with a through command the setup and the watch start call no pueue at all", async () => {
    const home = await holderHome(["winbox-heavy", "run", "--"], "none")
    try {
      const lines: Array<string> = []
      const originalLog = console.log
      console.log = (...args: Array<unknown>) => { lines.push(args.map(String).join(" ")) }
      try {
        await withLoggingPueue(home, () => runEffect(startHeavyWatch(home, ["orc"], "orc heavy watch")))
      } finally {
        console.log = originalLog
      }
      expect(await pueueCalls(home)).toBe("")
      expect(lines.join("\n")).toContain("winbox-heavy run --")
      expect(lines.join("\n")).toContain("no watchdog is armed")
      await writeFile(join(home, "fake", "winbox-heavy"), "#!/bin/sh\necho \"winbox-heavy $*\" >> \"$FAKE_HOLDER_LOG\"\nshift 2\n\"$@\"\n", { mode: 0o755 })
      await writeFile(join(home, "fake", "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      const holderLog = join(home, "holder.log")
      const child = Bun.spawnSync([join(home, "heavy", "bin", "bun"), "test"], {
        env: { ...process.env, PATH: join(home, "heavy", "bin") + ":" + join(home, "fake") + ":" + (process.env.PATH ?? ""), FAKE_HOLDER_LOG: holderLog },
        stdout: "pipe",
        stderr: "pipe"
      })
      expect(child.exitCode).toBe(0)
      expect(await readFile(holderLog, "utf8")).toBe("winbox-heavy run -- " + join(home, "fake", "bun") + " test\n")
      expect(await pueueCalls(home)).toBe("")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)

  test("without a through command the setup still makes the pueue group and queues the watch", async () => {
    const home = await holderHome(null)
    try {
      await withLoggingPueue(home, () => runEffect(startHeavyWatch(home, ["orc"], "orc heavy watch")))
      const calls = await pueueCalls(home)
      expect(calls).toContain("pueue group add heavy --parallel 1")
      expect(calls).toContain("pueue add --group orc-heavy-watch-")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("with a through command the watch-once fails instead of reporting slips", async () => {
    const home = await holderHome(["winbox-heavy", "run", "--"])
    try {
      await mkdir(join(home, "backlog"), { recursive: true })
      await writeFile(join(home, "backlog", "alerts.jsonl"), "")
      const failure = await withLoggingPueue(home, () => runEffect(Effect.flip(watchOnce(home))))
      expect(failure.detail).toContain("winbox-heavy run --")
      expect(await pueueCalls(home)).toBe("")
      expect(await readFile(join(home, "backlog", "alerts.jsonl"), "utf8")).toBe("")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check names the through command instead of reporting a missing pueue group", async () => {
    const home = await holderHome(["winbox-heavy", "run", "--"])
    try {
      const failure = await withLoggingPueue(home, () => runEffect(Effect.flip(checkHeavy(home))))
      expect(failure.detail).toBe("heavy check: the heavy calls queue through winbox-heavy run --, which keeps no pueue group to read")
      expect(await pueueCalls(home)).toBe("")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a stale stand-in leaves the bin dir on the next write", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-heavy-bin-"))
    try {
      const first = await runEffect(
        Effect.provide(
          writeHeavyBin(home, { group: "heavy", commands: ["tool"], limit: "auto", through: null }, "linux"),
          BunServices.layer
        )
      )
      expect(first).toContain("tool")
      const second = await runEffect(
        Effect.provide(
          writeHeavyBin(home, { group: "heavy", commands: [], limit: "auto", through: null }, "linux"),
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
          writeHeavyBin(home, { group: "heavy", commands: ["tool"], limit: "auto", through: null }, "linux"),
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
