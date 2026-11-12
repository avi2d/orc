import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { helperCommand, waiterWord } from "../../../packages/run/src/entities/heavy-queue/heavy-standin-runtime"
import { run, setup, type Harness } from "./heavy-standin-harness"

let harnesses: Array<Harness> = []

afterEach(async () => {
  for (const harness of harnesses) {
    await rm(harness.root, { recursive: true, force: true })
  }
  harnesses = []
})

const track = (harness: Harness): Harness => {
  harnesses.push(harness)
  return harness
}

const shellLines = (script: string): ReadonlyArray<string> =>
  script.split("\n").filter((line) => line !== "" && !line.startsWith("#"))

describe("the heavy stand-in launcher", () => {
  test("a written stand-in holds three shell lines instead of a script that decides in shell", async () => {
    const harness = track(await setup(["bun"]))
    expect(shellLines(await readFile(join(harness.bin, "bun"), "utf8"))).toHaveLength(3)
  })

  test("a direct call that the tool ends by a signal reaches the caller as that signal instead of an exit code", async () => {
    const harness = track(await setup(["bun"]))
    await writeFile(join(harness.root, "fake", "bun"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 })
    const child = Bun.spawnSync([join(harness.bin, "bun"), "install"], { env: harness.env, stdout: "pipe", stderr: "pipe" })
    expect(child.signalCode).toBe("SIGTERM")
  })

  test("a direct call reads the caller's input instead of an empty one", async () => {
    const harness = track(await setup(["bun"]))
    await writeFile(join(harness.root, "fake", "bun"), "#!/bin/sh\ncat\n", { mode: 0o755 })
    const child = Bun.spawnSync([join(harness.bin, "bun"), "install"], { env: harness.env, stdin: Buffer.from("from-the-caller"), stdout: "pipe" })
    expect(child.stdout.toString()).toBe("from-the-caller")
  })

  test("a direct call keeps the tool's exit code instead of the launcher's", async () => {
    const harness = track(await setup(["bun"]))
    expect(run(harness, "bun", ["install"], { FAKE_TOOL_EXIT: "5" }).code).toBe(5)
  })
})

describe("the queued call waiter", () => {
  test("a queued call whose stand-in is gone stops instead of holding the slot", async () => {
    const gone = Bun.spawnSync(["true"]).pid
    const started = Date.now()
    const child = Bun.spawnSync([...helperCommand, waiterWord, String(gone), "sleep", "30"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(child.exitCode).toBe(143)
  }, 30_000)

  test("a queued call keeps its exit code instead of the waiter's", () => {
    const child = Bun.spawnSync([...helperCommand, waiterWord, String(process.pid), "sh", "-c", "exit 4"], { stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode).toBe(4)
  })
})
