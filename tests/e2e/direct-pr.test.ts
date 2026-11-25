import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runStatus } from "../../packages/run/src/entities/run-history/index"
import { capturedSession, cleanFinish, commitOnBranch, ghPrLink, git, readyToCheck, recordingKinds, runDirectPrResume, runDirectPrStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const isNamedSignal = (value: unknown): value is { readonly name: string } =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"

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
          const kinds: Array<string> = []
          const outcome = await runDirectPrStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses)
          const bodyFile = join(home, "runs", "step-run-1", "pr-body.md")
          expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
          expect(outcome.report.endReason).toContain("The review turn failed, so the review did not pass")
          expect(outcome.nmCalls).toBe("")
          expect(branchOn(origin)).toBe(sha)
          expect(callLines(outcome.ghCalls)).toEqual([
            "pr list --head orc/test --state open --json url --jq .[0].url // empty",
            "pr create --head orc/test --title work --body-file " + bodyFile,
            "api --hostname github.com repos/o/r/commits/" + sha + "/check-runs?per_page=100"
          ])
          expect(outcome.report.completed).toBe(false)
          expect(outcome.report.waitingOnCi).toBe(true)
          expect(outcome.report.endReason).toContain("CI verdict for " + sha.slice(0, 12) + ": pending, waiting on CI because no check run has reported on " + sha + " yet.")
          expect(outcome.report.noMistakes).toBeNull()
          expect(outcome.report.prLink).toBe(ghPrLink)
          expect(outcome.run?.prLink).toBe(ghPrLink)
          expect(outcome.run?.status).toBe("running")
          expect(outcome.signals).toContainEqual({ name: "open-question", value: expect.stringContaining('"id":"ci-waiting"') })
          expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
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

  test.each(["success", "failure"])("a test-only config records skipped checks instead of passed checks and follows CI %s", async (conclusion) => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const sha = await readyToCheck(dir, home)
          await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  test: forbidden-test-runner\n")
          const checkRuns = JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "test", head_sha: sha, status: "completed", conclusion }] })
          const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), async () => {
            throw new Error("a skipped test command must not start")
          }, checkRuns)
          expect(outcome.steps).toContainEqual({ name: "checks", status: "skipped" })
          expect(outcome.report.checksRounds).toHaveLength(1)
          expect(outcome.report.checksRounds?.[0]).toMatchObject({ passed: false, checks: [], failed: [] })
          expect(outcome.report.completed).toBe(conclusion === "success")
          expect(runStatus(outcome.report)).toBe(conclusion === "success" ? "completed" : "CI failed")
          expect(outcome.report.endReason).toContain("No local checks ran.")
          expect(outcome.report.endReason).not.toContain("checks passed")
          expect(await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8")).toContain("without local checks or no-mistakes")
          const resumed = await runDirectPrResume(dir, home, sandboxResult(sha), async () => {
            throw new Error("a resumed skipped test command must not start")
          }, checkRuns, [])
          expect(resumed.steps).toContainEqual({ name: "checks", status: "skipped" })
          expect(resumed.report.checksRounds).toHaveLength(1)
          expect(resumed.report.completed).toBe(conclusion === "success")
          expect(runStatus(resumed.report)).toBe(conclusion === "success" ? "completed" : "CI failed")
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
          expect(outcome.report.completed).toBe(false)
          expect(outcome.report.waitingOnCi).toBe(true)
          expect(outcome.run?.status).toBe("running")
        })
      })
    })
  })

  test("a failed CI check run on the pushed head ends the run failed with the check's name", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const sha = await readyToCheck(dir, home)
          const checkRuns = JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "test", head_sha: sha, status: "completed", conclusion: "failure" }] })
          const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), lintPasses, checkRuns)
          expect(outcome.report.prLink).toBe(ghPrLink)
          expect(outcome.report.completed).toBe(false)
          expect(outcome.report.waitingOnCi).toBe(false)
          expect(outcome.run?.status).toBe("failed")
          expect(outcome.run?.endReason).toContain("CI verdict for " + sha.slice(0, 12) + ": failed, the check test failed.")
          expect(runStatus(outcome.report)).toBe("CI failed")
          expect(outcome.signals).not.toContainEqual(expect.objectContaining({ name: "open-question" }))
        })
      })
    })
  })

  test("a resumed run that finds failed CI closes failed without keeping the waiting question", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const sha = await readyToCheck(dir, home)
          const first = await runDirectPrStep(dir, home, sandboxResult(sha), lintPasses)
          expect(first.run?.status).toBe("running")
          const failedRuns = JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "test", head_sha: sha, status: "completed", conclusion: "failure" }] })
          const second = await runDirectPrResume(dir, home, sandboxResult(sha), lintPasses, failedRuns, [{ question: "ci-waiting", answer: "CI finished, read the verdict again" }])
          expect(second.report.completed).toBe(false)
          expect(second.report.waitingOnCi).toBe(false)
          expect(second.run?.status).toBe("failed")
          expect(second.run?.endReason).toContain("CI verdict for " + sha.slice(0, 12) + ": failed, the check test failed.")
          const rows = Array.isArray(second.runSignals) ? second.runSignals : []
          expect(rows.filter(isNamedSignal).filter((signal) => signal.name === "open-question")).toEqual([])
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
