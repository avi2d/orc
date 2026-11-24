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

  const guardedRepo = async () => {
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
    return { bin, run }
  }

  test("relative and absolute runner paths are refused instead of starting their executables, while tsc still runs", async () => {
    const { bin, run } = await guardedRepo()
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

  test("a runner path without ./, after an assignment, after exec or command, or in quotes is still refused", async () => {
    const { run } = await guardedRepo()
    for (const command of [
      "node_modules/.bin/vitest run",
      "CI=1 ./node_modules/.bin/vitest run",
      "exec ./node_modules/.bin/vitest run",
      "command ./node_modules/.bin/vitest run",
      "\"./node_modules/.bin/vitest\" run",
      "true && ./node_modules/.bin/vitest run"
    ]) {
      const result = run(command)
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toBe("")
      expect(result.stderr.toString()).toContain("BASH_ENV command-shape guard")
    }
    for (const command of ["CI=1 ./node_modules/.bin/tsc", "exec \"./node_modules/.bin/tsc\"", "ls node_modules/.bin/vitest > /dev/null; ./node_modules/.bin/tsc"]) {
      const result = run(command)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe("started\n")
    }
  })

  test("the guard leaves PIPESTATUS and $_ as Bash set them instead of overwriting them with its own commands", async () => {
    const { run } = await guardedRepo()
    const pipe = run("false | true; echo \"${PIPESTATUS[@]}\"")
    expect(pipe.stdout.toString()).toBe("1 0\n")
    const last = run("echo a b c > /dev/null; echo \"$_\"")
    expect(last.stdout.toString()).toBe("c\n")
  })
})
