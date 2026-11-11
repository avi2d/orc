import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { hostExec } from "../../packages/run/src/shared/sandbox/agent-exec"
import { installCopy } from "../../packages/run/src/run-exec"
import { OrcRunError } from "../../packages/run/src/shared/lib/run-session"

const runInstall = (copyDir: string, logFile: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const exec = hostExec(copyDir, Bun.env, {})
      yield* installCopy(spawner, fs, path, exec, logFile)
    }).pipe(Effect.provide(BunServices.layer))
  )

describe("installCopy", () => {
  test("runs the prepare command in the copy instead of skipping the install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-install-"))
    try {
      const copyDir = join(dir, "copy")
      await Bun.$`mkdir -p ${copyDir}`.quiet()
      await Bun.write(join(copyDir, ".no-mistakes.yaml"), "commands:\n  prepare: echo prepared > prepared.txt\n")
      const logFile = join(dir, "prepare.log")
      await runInstall(copyDir, logFile)
      expect(await Bun.file(join(copyDir, "prepared.txt")).text()).toBe("prepared\n")
      const log = await readFile(logFile, "utf8")
      expect(log).toContain("$ echo prepared > prepared.txt")
      expect(log).toContain("exit 0")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses the run when prepare fails instead of ignoring the failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-install-"))
    try {
      const copyDir = join(dir, "copy")
      await Bun.$`mkdir -p ${copyDir}`.quiet()
      await Bun.write(join(copyDir, ".no-mistakes.yaml"), "commands:\n  prepare: exit 3\n")
      const logFile = join(dir, "prepare.log")
      let message = ""
      try {
        await runInstall(copyDir, logFile)
        throw new Error("installCopy succeeded when the prepare command failed")
      } catch (error) {
        if (!(error instanceof OrcRunError)) throw error
        message = error.message
      }
      expect(message).toContain("so Pi did not start")
      expect(message).toContain("prepare.log")
      const log = await readFile(logFile, "utf8")
      expect(log).toContain("exit 3")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses the run when .no-mistakes.yaml names no commands instead of skipping the install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-install-"))
    try {
      const copyDir = join(dir, "copy")
      await Bun.$`mkdir -p ${copyDir}`.quiet()
      await Bun.write(join(copyDir, ".no-mistakes.yaml"), "other: 1\n")
      const logFile = join(dir, "prepare.log")
      let message = ""
      try {
        await runInstall(copyDir, logFile)
        throw new Error("installCopy succeeded when the prepare config named no checks")
      } catch (error) {
        if (!(error instanceof OrcRunError)) throw error
        message = error.message
      }
      expect(message).toContain(".no-mistakes.yaml")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips the install when the copy names checks but no prepare command instead of refusing the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-install-"))
    try {
      const copyDir = join(dir, "copy")
      await Bun.$`mkdir -p ${copyDir}`.quiet()
      await Bun.write(join(copyDir, ".no-mistakes.yaml"), "commands:\n  test: \"true\"\n")
      const logFile = join(dir, "prepare.log")
      await runInstall(copyDir, logFile)
      expect(await Bun.file(logFile).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips the install when the copy holds no prepare file instead of refusing the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-install-"))
    try {
      const copyDir = join(dir, "copy")
      await Bun.$`mkdir -p ${copyDir}`.quiet()
      const logFile = join(dir, "prepare.log")
      await runInstall(copyDir, logFile)
      expect(await Bun.file(logFile).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
