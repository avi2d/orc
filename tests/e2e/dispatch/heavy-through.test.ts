import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { run, setupThrough, type ThroughHarness } from "./heavy-standin-harness"

let harnesses: Array<ThroughHarness> = []

afterEach(async () => {
  for (const harness of harnesses) {
    await rm(harness.root, { recursive: true, force: true })
  }
  harnesses = []
})

const holderRun = ["winbox-heavy", "run", "--"]

const track = (harness: ThroughHarness): ThroughHarness => {
  harnesses.push(harness)
  return harness
}

describe("the heavy stand-in with heavy.through set", () => {
  test("a queued call runs as the through command, the real tool and its args, and never as pueue add", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    const result = run(harness, "bun", ["test", "login.test.ts"])
    expect(result.code).toBe(0)
    expect(await harness.holderLog()).toBe("winbox-heavy run -- " + join(harness.fake, "bun") + " test login.test.ts\n")
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("bun test login.test.ts")
  })

  test("the real tool's exit code, stdout and stderr pass through without a queue line added", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    await writeFile(join(harness.fake, "bun"), "#!/bin/sh\nprintf 'out-line\\n'\nprintf 'err-line\\n' >&2\nexit 3\n", { mode: 0o755 })
    const result = run(harness, "bun", ["test"])
    expect(result.code).toBe(3)
    expect(result.stdout).toBe("out-line\n")
    expect(result.stderr).toBe("err-line\n")
  })

  test("a heavy call started inside the held slot runs directly instead of waiting on the slot it holds", async () => {
    const harness = track(await setupThrough(["bun", "vitest"], holderRun))
    await writeFile(join(harness.fake, "bun"), "#!/bin/sh\nvitest run x.test.ts\n", { mode: 0o755 })
    const result = run(harness, "bun", ["test"])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(await harness.holderLog()).toBe("winbox-heavy run -- " + join(harness.fake, "bun") + " test\n")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("vitest run x.test.ts")
  })

  test("a heavy call under a direct through holder runs at once instead of queuing a second time", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    const child = Bun.spawnSync([join(harness.fake, "winbox-heavy"), "run", "--", join(harness.bin, "bun"), "test"], {
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    expect(await harness.holderLog()).toBe("winbox-heavy run -- " + join(harness.bin, "bun") + " test\n")
    expect(await harness.pueueLog()).toBe("")
  })

  test("a heavy call under a bun-run holder script runs at once instead of queuing a second time", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    const child = Bun.spawnSync([process.execPath, join(harness.fake, "winbox-heavy.ts"), "run", "--", join(harness.bin, "bun"), "test"], {
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    expect(await harness.holderLog()).toBe("winbox-heavy run -- " + join(harness.bin, "bun") + " test\n")
    expect(await harness.pueueLog()).toBe("")
  })

  test("a heavy call under an interpreter-run holder whose through word carries its extension runs at once instead of queuing a second time", async () => {
    const harness = track(await setupThrough(["bun"], holderRun, (fake) => join(fake, "winbox-heavy.sh")))
    const child = Bun.spawnSync(["sh", join(harness.fake, "winbox-heavy.sh"), "run", "--", join(harness.bin, "bun"), "test"], {
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    expect(await harness.holderLog()).toBe("winbox-heavy run -- " + join(harness.bin, "bun") + " test\n")
    expect(await harness.pueueLog()).toBe("")
  })

  test("a heavy call under a shell script mentioning the through words still reaches the holder instead of running outside the limit", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    const child = Bun.spawnSync(["sh", "-c", "winbox-heavy run -- true; bun test"], {
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    expect(await harness.holderLog()).toBe(
      "winbox-heavy run -- true\n" +
      "winbox-heavy run -- " + join(harness.fake, "bun") + " test\n"
    )
    expect(await harness.pueueLog()).toBe("")
  })

  test("a call that never queues skips the through command", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    const result = run(harness, "bun", ["install"])
    expect(result.code).toBe(0)
    expect(await harness.holderLog()).toBe("")
    expect(await harness.pueueLog()).toBe("")
  })

  test("a bypass skips the through command", async () => {
    const harness = track(await setupThrough(["bun"], holderRun))
    const result = run(harness, "bun", ["test"], { HEAVY_QUEUE_BYPASS: "release smoke" })
    expect(result.code).toBe(0)
    expect(await harness.holderLog()).toBe("")
  })

  test("a through word with a quote and a space reaches the command as one word instead of splitting", async () => {
    const harness = track(await setupThrough(["bun"], ["winbox-heavy", "run", "it's one"]))
    const result = run(harness, "bun", ["test"])
    expect(result.code).toBe(0)
    expect(await harness.holderLog()).toBe("winbox-heavy run it's one " + join(harness.fake, "bun") + " test\n")
  })
})
