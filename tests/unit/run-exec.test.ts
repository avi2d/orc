import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { hostExec } from "../../packages/run/src/agent-exec"
import { installCopy } from "../../packages/run/src/run-exec"
import { OrcRunError } from "../../packages/run/src/run-session"

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
      let piStarted = false
      await runInstall(copyDir, logFile)
      piStarted = true
      expect(piStarted).toBe(true)
      expect(await Bun.file(join(copyDir, "prepared.txt")).text()).toBe("prepared\n")
      const log = await readFile(logFile, "utf8")
      expect(log).toContain("$ echo prepared > prepared.txt")
      expect(log).toContain("exit 0")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses the run when prepare fails instead of starting Pi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-install-"))
    try {
      const copyDir = join(dir, "copy")
      await Bun.$`mkdir -p ${copyDir}`.quiet()
      await Bun.write(join(copyDir, ".no-mistakes.yaml"), "commands:\n  prepare: exit 3\n")
      const logFile = join(dir, "prepare.log")
      let piStarted = false
      let message = ""
      try {
        await runInstall(copyDir, logFile)
        piStarted = true
      } catch (error) {
        message = error instanceof OrcRunError ? error.message : String(error)
      }
      expect(piStarted).toBe(false)
      expect(message).toContain("so Pi did not start")
      expect(message).toContain("prepare.log")
      const log = await readFile(logFile, "utf8")
      expect(log).toContain("exit 3")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
