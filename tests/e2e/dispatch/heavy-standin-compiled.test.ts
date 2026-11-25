import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { helperCommand, waiterWord, type StandinCall } from "../../../packages/run/src/entities/heavy-queue/heavy-standin-runtime"
import { setup, type Harness } from "./heavy-standin-harness"

let built = ""
let compiled = ""
let harnesses: Array<Harness> = []

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), "orc-heavy-compiled-"))
  compiled = join(built, "heavy-standin")
  const build = Bun.spawnSync(["bun", join(import.meta.dir, "../../../packages/run/scripts/build-heavy-standin.ts"), compiled], { stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  expect(build.stderr.toString()).toBe("")
  expect(build.exitCode).toBe(0)
}, 150_000)

afterAll(async () => {
  await rm(built, { recursive: true, force: true })
})

afterEach(async () => {
  for (const harness of harnesses) {
    await rm(harness.root, { recursive: true, force: true })
  }
  harnesses = []
})

const bunHarness = async (): Promise<Harness> => {
  const harness = await setup(["bun"])
  harnesses.push(harness)
  return harness
}

const settingsOf = (harness: Harness): string => {
  const call: StandinCall = {
    tool: "bun", commands: [], home: harness.root, group: "heavy", wrap: "", real: join(harness.root, "fake", "bun"), through: null,
    timing: { budgetMinutes: null, pollSeconds: 1 }
  }
  return JSON.stringify(call)
}

const launch = (helper: ReadonlyArray<string>, harness: Harness, args: ReadonlyArray<string>, extra: Record<string, string> = {}) => {
  const child = Bun.spawnSync([...helper, settingsOf(harness), join(harness.bin, "bun"), ...args], {
    env: { ...harness.env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000
  })
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

const toolLog = (harness: Harness): Promise<string> => readFile(join(harness.root, "tool.log"), "utf8").catch(() => "")

describe("the compiled heavy stand-in", () => {
  test.each([
    [["test", "x"], "1 1"],
    [["test", "--timeout", "20000"], "1 0"],
    [["run", "dev"], "0 0"],
    [["install"], "0 0"]
  ] satisfies ReadonlyArray<readonly [ReadonlyArray<string>, string]>)("bun %j classifies as %s, the same as the source helper", async (args, words) => {
    const harness = await bunHarness()
    const classify = { HEAVY_CLASSIFY: "1" }
    expect(launch([compiled], harness, args, classify).stdout.trim()).toBe(words)
    expect(launch(helperCommand, harness, args, classify).stdout.trim()).toBe(words)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a direct call reaches the real tool with the tool's exit code instead of the stand-in's", async () => {
    const harness = await bunHarness()
    const result = launch([compiled], harness, ["install"], { FAKE_TOOL_EXIT: "5" })
    expect(result.code).toBe(5)
    expect(await toolLog(harness)).toBe("real " + join(harness.root, "fake", "bun") + " install\n")
    expect(await harness.pueueLog()).toBe("")
  })

  test("a queued call re-executes the compiled file as the waiter instead of bun on an embedded path", async () => {
    const harness = await bunHarness()
    expect(launch([compiled], harness, ["test", "--timeout", "20000"]).code).toBe(0)
    const added = (await harness.pueueLog()).split("\n").find((line) => line.startsWith("pueue add ")) ?? ""
    const queued = added.split(" -- ")[1]?.split(" ") ?? []
    expect(queued.slice(0, 2)).toEqual([compiled, waiterWord])
    expect(queued.slice(3)).toEqual([join(harness.root, "fake", "bun"), "test", "--timeout", "20000"])
    const waiter = Bun.spawnSync(queued, { env: { ...harness.env, FAKE_TOOL_EXIT: "3" }, stdout: "pipe", stderr: "pipe", timeout: 30_000 })
    expect(waiter.exitCode).toBe(3)
    expect(await toolLog(harness)).toBe("real " + join(harness.root, "fake", "bun") + " test --timeout 20000\n")
  })

  test("a queued call whose stand-in is gone stops instead of holding the slot", () => {
    const gone = Bun.spawnSync(["true"]).pid
    const started = Date.now()
    const child = Bun.spawnSync([compiled, waiterWord, String(gone), "sleep", "30"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(child.exitCode).toBe(143)
  }, 30_000)

  test("a TERM sent to the compiled stand-in reaches the running tool instead of leaving it behind", async () => {
    const harness = await bunHarness()
    const ready = join(harness.root, "ready")
    await writeFile(
      join(harness.root, "fake", "bun"),
      '#!/bin/sh\ntrap \'echo term >> "$FAKE_TOOL_LOG"; exit 7\' TERM\n: > "' + ready + '"\nwhile :; do sleep 0.1; done\n',
      { mode: 0o755 }
    )
    const child = Bun.spawn([compiled, settingsOf(harness), join(harness.bin, "bun"), "install"], { env: harness.env, stdout: "pipe", stderr: "pipe" })
    for (let waited = 0; !(await Bun.file(ready).exists()) && waited < 10_000; waited += 50) {
      await Bun.sleep(50)
    }
    child.kill("SIGTERM")
    expect(await child.exited).toBe(7)
    expect(await toolLog(harness)).toBe("term\n")
  }, 30_000)
})
