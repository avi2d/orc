import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capturedSession, cleanFinish, commitOnBranch, ghPrLink, git, readyToCheck, runDirectPrStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const withOrigin = async (dir: string, use: (origin: string) => Promise<void>): Promise<void> => {
  const origin = await mkdtemp(join(tmpdir(), "orc-origin-"))
  try {
    git(origin, ["init", "-q", "--bare"])
    git(dir, ["remote", "add", "origin", origin])
    await use(origin)
  } finally {
    await rm(origin, { recursive: true, force: true })
  }
}

const branchOn = (origin: string): string | null => {
  const shown = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/heads/orc/test"], { cwd: origin })
  return shown.exitCode === 0 ? shown.stdout.toString().trim() : null
}

const lintPasses = async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 })

const callLines = (calls: string): ReadonlyArray<string> => calls.split("\n").filter((line) => line !== "")

describe("a direct-PR run opens its own PR after the checks", () => {
  test("pushes the branch and opens the PR instead of starting no-mistakes", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async (origin) => {
          const sha = await readyToCheck(dir, home)
          const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), lintPasses)
          const bodyFile = join(home, "runs", "step-run-1", "pr-body.md")
          expect(outcome.nmCalls).toBe("")
          expect(branchOn(origin)).toBe(sha)
          expect(callLines(outcome.ghCalls)).toEqual([
            "pr list --head orc/test --state open --json url --jq .[0].url // empty",
            "pr create --head orc/test --title work --body-file " + bodyFile
          ])
          expect(outcome.report.completed).toBe(true)
          expect(outcome.report.noMistakes).toBeNull()
          expect(outcome.report.prLink).toBe(ghPrLink)
          expect(outcome.run?.prLink).toBe(ghPrLink)
          expect(outcome.run?.status).toBe("succeeded")
          expect(outcome.steps).toContainEqual({ name: "pr", status: "passed" })
          expect(outcome.steps).not.toContainEqual(expect.objectContaining({ name: "no-mistakes" }))
          const body = await readFile(bodyFile, "utf8")
          expect(body).toContain("work")
          expect(body).toContain("after lint passed, without no-mistakes")
          expect(body).not.toContain("Do the thing.")
        })
      })
    })
  })

  test("opens a new PR when the branch has no open PR instead of reusing a closed one", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const sha = await readyToCheck(dir, home)
          const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), lintPasses)
          expect(callLines(outcome.ghCalls)[0]).toBe("pr list --head orc/test --state open --json url --jq .[0].url // empty")
          expect(callLines(outcome.ghCalls).some((line) => line.startsWith("pr create --head orc/test"))).toBe(true)
          expect(outcome.report.prLink).toBe(ghPrLink)
          expect(outcome.report.completed).toBe(true)
        })
      })
    })
  })

  test("a failing check pushes nothing and opens no PR instead of shipping the red branch", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async (origin) => {
          const sha = await commitOnBranch(dir, "orc/test")
          await capturedSession(home, sessionEnding(cleanFinish))
          await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
          const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), async () => ({ stdout: "", stderr: "lint blew up", exitCode: 1 }))
          expect(outcome.ghCalls).toBe("")
          expect(outcome.nmCalls).toBe("")
          expect(branchOn(origin)).toBeNull()
          expect(outcome.report.completed).toBe(false)
          expect(outcome.report.prLink).toBeNull()
          expect(outcome.run?.status).toBe("failed")
          expect(outcome.run?.endReason).toContain("No PR opens")
        })
      })
    })
  })

  test("a push that fails opens no PR instead of calling gh on an unpushed branch", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), lintPasses)
        expect(outcome.ghCalls).toBe("")
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.prLink).toBeNull()
        expect(outcome.run?.status).toBe("failed")
        expect(outcome.run?.endReason).toContain("git push of orc/test failed")
        expect(outcome.steps).toContainEqual({ name: "pr", status: "failed" })
      })
    })
  })
})
