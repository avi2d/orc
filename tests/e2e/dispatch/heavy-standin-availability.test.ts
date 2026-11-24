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
    expect(await rewrite()).toContain("python3")
    expect(await Bun.file(join(heavyBin, "python")).exists()).toBe(false)
    expect(await Bun.file(join(home, "heavy", "ci-only", "node")).exists()).toBe(true)
    expect(await Bun.file(join(home, "heavy", "ci-only", "checks-test")).exists()).toBe(true)
    expect(pythonFallback()).toEqual({ code: 0, stdout: "python3\n", stderr: "" })

    process.env.PATH = join(home, "heavy", "ci-only") + ":" + heavyBin + ":" + realBin
    await writeFile(join(realBin, "python"), "#!/bin/sh\nprintf 'python\\n'\n", { mode: 0o755 })
    expect(await rewrite()).toEqual(expect.arrayContaining(["python", "python3"]))
    expect(pythonFallback()).toEqual({ code: 0, stdout: "python\n", stderr: "" })

    await rm(join(realBin, "python"))
    expect(await rewrite()).toContain("python3")
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

test("writeHeavyBin does not drop project-only tools or CI-only refusals", async () => {
  const shell = Bun.which("sh")
  if (shell === null) {
    throw new Error("sh is required to probe command availability")
  }
  const home = await mkdtemp(join(tmpdir(), "orc-project-standins-"))
  const path = process.env.PATH
  const realBin = join(home, "real")
  const heavyBin = join(home, "heavy", "bin")
  const ciOnlyBin = join(home, "heavy", "ci-only")
  const projectBin = join(home, "project", "node_modules", ".bin")
  const inner = join(home, "project", "packages", "inner")
  const tools = ["node", "vitest", "jest", "playwright", "tsc", "eslint", "oxlint", "pytest", "project-tool"]
  try {
    await mkdir(realBin)
    await mkdir(projectBin, { recursive: true })
    await mkdir(inner, { recursive: true })
    for (const tool of tools) {
      await writeFile(join(projectBin, tool), "#!/bin/sh\nprintf '" + tool + " %s\\n' \"$@\"\n", { mode: 0o755 })
    }
    process.env.PATH = realBin
    const written = await Effect.runPromise(
      writeHeavyBin(home, { ...resolveHeavy(undefined), commands: ["project-tool"] }, "linux").pipe(Effect.provide(BunServices.layer))
    )
    const env = { PATH: ciOnlyBin + ":" + heavyBin + ":" + realBin, HEAVY_QUEUE_UNREACHABLE: "1", HEAVY_TESTS_CI_ONLY: "0" }
    for (const tool of tools) {
      expect(written).toContain(tool)
      expect(await Bun.file(join(heavyBin, tool)).exists()).toBe(true)
      const result = Bun.spawnSync([shell, "-c", tool + " src"], { cwd: inner, env, stdout: "pipe", stderr: "pipe" })
      expect({ tool, code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toEqual({
        tool, code: 0, stdout: tool + " src\n", stderr: ""
      })
    }
    for (const tool of ["python", "python3", "uv", "deno", "go", "cargo", "make"]) {
      expect(written).not.toContain(tool)
      expect(await Bun.file(join(heavyBin, tool)).exists()).toBe(false)
    }
    for (const tool of ["node", "checks-test"]) {
      expect(await Bun.file(join(ciOnlyBin, tool)).exists()).toBe(true)
    }
    const refused = Bun.spawnSync([shell, "-c", "checks-test"], {
      cwd: inner,
      env: { ...env, HEAVY_TESTS_CI_ONLY: "1" },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout.toString()).toBe("")
    expect(refused.stderr.toString()).toContain("repository tests run only in GitHub CI")
  } finally {
    if (path === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = path
    }
    await rm(home, { recursive: true, force: true })
  }
})
