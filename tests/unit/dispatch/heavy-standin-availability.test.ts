import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { resolveHeavy } from "../../../packages/run/src/entities/heavy-queue/heavy"
import { writeHeavyBin } from "../../../packages/run/src/entities/heavy-queue/heavy-setup"

test("stand-in writes preserve Python fallback instead of advertising a missing interpreter", async () => {
  const shell = Bun.which("sh")
  if (shell === null) {
    throw new Error("sh is required to probe command availability")
  }
  const home = await mkdtemp(join(tmpdir(), "orc-standin-availability-"))
  const path = process.env.PATH
  const realBin = join(home, "real")
  const heavyBin = join(home, "heavy", "bin")
  const settings = { ...resolveHeavy(undefined), commands: ["missing-tool"] }
  const rewrite = () => Effect.runPromise(writeHeavyBin(home, settings, "linux").pipe(Effect.provide(BunServices.layer)))
  const pythonFallback = () => {
    const result = Bun.spawnSync([shell, "-c", "if command -v python >/dev/null; then python; else python3; fi"], {
      env: { ...process.env, PATH: heavyBin + ":" + realBin },
      stdout: "pipe",
      stderr: "pipe"
    })
    return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) }
  }
  try {
    await mkdir(realBin)
    await writeFile(join(realBin, "python3"), "#!/bin/sh\nprintf 'python3\\n'\n", { mode: 0o755 })
    process.env.PATH = realBin
    expect(await rewrite()).toEqual(["python3"])
    expect(await Bun.file(join(heavyBin, "python")).exists()).toBe(false)
    expect(await Bun.file(join(home, "heavy", "ci-only", "node")).exists()).toBe(false)
    expect(await Bun.file(join(home, "heavy", "ci-only", "checks-test")).exists()).toBe(false)
    expect(pythonFallback()).toEqual({ code: 0, stdout: "python3\n", stderr: "" })

    process.env.PATH = join(home, "heavy", "ci-only") + ":" + heavyBin + ":" + realBin
    await writeFile(join(realBin, "python"), "#!/bin/sh\nprintf 'python\\n'\n", { mode: 0o755 })
    expect(await rewrite()).toEqual(["python", "python3"])
    expect(pythonFallback()).toEqual({ code: 0, stdout: "python\n", stderr: "" })

    await rm(join(realBin, "python"))
    expect(await rewrite()).toEqual(["python3"])
    expect(await Bun.file(join(heavyBin, "python")).exists()).toBe(false)
    expect(pythonFallback()).toEqual({ code: 0, stdout: "python3\n", stderr: "" })
  } finally {
    if (path === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = path
    }
    await rm(home, { recursive: true, force: true })
  }
})
