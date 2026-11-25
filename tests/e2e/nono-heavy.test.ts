import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { standinHelper, withHeavyPath } from "../../packages/run/src/entities/heavy-queue/index"
import { resolveHeavy } from "../../packages/run/src/entities/heavy-queue/heavy"
import { writeHeavyBin } from "../../packages/run/src/entities/heavy-queue/heavy-setup"
import { makeNonoFixtureDir } from "../lib/nono-home"
import { withNonoShell } from "../lib/nono-shell"

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["git", "-c", "user.name=orc", "-c", "user.email=orc@example.com", ...args], { cwd, env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.exitCode !== 0) {
    throw new Error("git " + args.join(" ") + ": " + result.stderr.toString())
  }
}

const scripts = { test: "echo ran-tests", build: "echo built", lint: "echo linted", typecheck: "echo typechecked" }

const seedCopy = async (dir: string): Promise<void> => {
  const main = join(dir, "main")
  await mkdir(main)
  git(main, ["init", "-q", "-b", "main"])
  await writeFile(join(main, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts }) + "\n")
  git(main, ["add", "package.json"])
  git(main, ["commit", "-qm", "seed"])
  git(main, ["worktree", "add", "-q", "-b", "orc/t", join(dir, "copy")])
}

const refused = ["bun test", "bun run test", "bunx vitest", "npm test", "npx jest"]
const passed: ReadonlyArray<readonly [string, string]> = [["bun run build", "built"], ["bun run lint", "linted"], ["bun run typecheck", "typechecked"]]

describe("the heavy stand-in inside the nono sandbox", () => {
  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to run the sandbox", "test runners are refused through the stand-in while build, lint and typecheck run, and the stand-in folder stays read-only"),
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "orc-nono-heavy-")))
      const home = await makeNonoFixtureDir("orc-nono-heavy-home-")
      const orcHome = await makeNonoFixtureDir("orc-nono-heavy-orc-")
      try {
        await seedCopy(dir)
        await Effect.runPromise(writeHeavyBin(orcHome, resolveHeavy(undefined), "linux").pipe(Effect.provide(BunServices.layer)))
        const options = {
          worktree: join(dir, "copy"),
          piSessionDir: join(dir, "run", "session"),
          sessionsDir: join(dir, "run", "sessions"),
          hostEnv: { PATH: withHeavyPath(orcHome, Bun.env.PATH ?? ""), HOME: home },
          standinHelper,
          env: {}
        }
        await withNonoShell(options, async (shell) => {
          for (const command of refused) {
            const result = await shell(command)
            expect({ command, exitCode: result.exitCode }).toEqual({ command, exitCode: 1 })
            expect(result.stderr).toContain("orc heavy: " + command + " starts a test run")
            expect(result.stdout).not.toContain("ran-tests")
          }
          for (const [command, output] of passed) {
            const result = await shell(command)
            expect({ command, exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ command, exitCode: 0 })
            expect(result.stdout).toContain(output)
          }
          const write = await shell("echo changed > \"" + join(orcHome, "heavy", "bin", "bun") + "\"")
          expect(write.exitCode).not.toBe(0)
        })
        expect(await readFile(join(orcHome, "heavy", "bin", "bun"), "utf8")).toContain("Written by orc heavy path")
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(home, { recursive: true, force: true })
        await rm(orcHome, { recursive: true, force: true })
      }
    },
    120_000
  )
})
