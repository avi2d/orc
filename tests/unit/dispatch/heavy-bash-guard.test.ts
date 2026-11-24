import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ciOnlyBashScript } from "../../../packages/run/src/entities/heavy-queue/heavy-standin"

describe("CI-only Bash command guard", () => {
  let root = ""

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("relative and absolute runner paths are refused instead of starting their executables, while tsc still runs", async () => {
    root = await mkdtemp(join(tmpdir(), "orc-bash-guard-"))
    const bin = join(root, "node_modules", ".bin")
    const startup = join(root, "startup")
    await mkdir(bin, { recursive: true })
    await writeFile(startup, ciOnlyBashScript())
    for (const tool of ["vitest", "jest", "pytest", "checks-test", "playwright", "npm", "tsc"]) {
      await writeFile(join(bin, tool), "#!/bin/sh\nprintf 'started\\n'\n", { mode: 0o755 })
    }
    const run = (command: string) => Bun.spawnSync(["/bin/bash", "-c", command], {
      cwd: root, env: { PATH: "/usr/bin:/bin", BASH_ENV: startup, HEAVY_TESTS_CI_ONLY: "1" }
    })
    for (const tool of ["vitest", "jest", "pytest", "checks-test"]) {
      for (const path of ["./node_modules/.bin/" + tool, join(bin, tool)]) {
        const result = run(path + " run")
        expect(result.exitCode).toBe(1)
        expect(result.stdout.toString()).toBe("")
        expect(result.stderr.toString()).toContain("BASH_ENV command-shape guard")
      }
    }
    for (const command of ["./node_modules/.bin/playwright test", "./node_modules/.bin/npm test"]) {
      const result = run(command)
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toBe("")
      expect(result.stderr.toString()).toContain("BASH_ENV command-shape guard")
    }
    const install = run("./node_modules/.bin/playwright install")
    expect(install.exitCode).toBe(0)
    expect(install.stdout.toString()).toBe("started\n")
    const tsc = run("./node_modules/.bin/tsc")
    expect(tsc.exitCode).toBe(0)
    expect(tsc.stdout.toString()).toBe("started\n")
  })
})
