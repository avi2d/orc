import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runStatus } from "../../packages/run/src/entities/run-history/index"
import { capturedSession, cleanFinish, commitOnBranch, ghPrLink, git, readyToCheck, recordingKinds, runDirectPrResume, runDirectPrStep, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

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

describe("orc delivery", () => {
  test("malformed reviewer output fails the review step by name instead of opening a PR", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const baseBranch = git(dir, ["branch", "--show-current"])
          git(dir, ["push", "-u", "origin", baseBranch])
          git(dir, ["remote", "set-head", "origin", baseBranch])
          const sha = await readyToCheck(dir, home)
          git(dir, ["checkout", "-q", "orc/test"])
          const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(async (run, sessionsDir) => {
            if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
            const sessionFile = join(sessionsDir, "review-invalid.jsonl")
            await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: "[{}]" }], stopReason: "stop", usage: { input: 1, output: 1 } }))
            return { sessionFile, commits: [] }
          }, []), lintPasses)
          expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
          expect(outcome.report.endReason).toContain("OrcReviewOutputError")
          expect(outcome.ghCalls).toBe("")
        })
      })
    })
  })

  test("rebases before checks and records the reviewer findings instead of skipping review", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const baseBranch = git(dir, ["branch", "--show-current"])
          git(dir, ["push", "-u", "origin", baseBranch])
          git(dir, ["remote", "set-head", "origin", baseBranch])
          const sha = await readyToCheck(dir, home)
          await writeFile(join(dir, "base.txt"), "new base\n")
          git(dir, ["add", "base.txt"])
          git(dir, ["commit", "-qm", "base update"])
          const base = git(dir, ["rev-parse", "HEAD"])
          git(dir, ["push", "origin", baseBranch])
          git(dir, ["checkout", "-q", "orc/test"])
          const kinds: Array<string> = []
          let checkedBase = ""
          const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(async (run, sessionsDir) => {
            if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
            const sessionFile = join(sessionsDir, "review.jsonl")
            await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: JSON.stringify([]) }], stopReason: "stop", usage: { input: 1, output: 1 } }))
            expect(checkedBase).not.toBe("")
            return { sessionFile, commits: [] }
          }, kinds), async () => {
            checkedBase = git(dir, ["rev-parse", "HEAD^"])
            return lintPasses()
          })
          expect(checkedBase).toBe(base)
          expect(kinds).toEqual(["implementer", "reviewer"])
          expect(outcome.steps).toContainEqual({ name: "review", status: "passed" })
          expect(outcome.signals).toContainEqual({ name: "review-findings", value: "0" })
          expect(JSON.parse(await readFile(join(home, "runs", "step-run-1", "review.json"), "utf8"))).toEqual([])
          expect(outcome.nmCalls).toBe("")
          expect(outcome.ghCalls).toContain("pr create --head orc/test")
          expect(outcome.ghCalls).not.toContain("check-runs")
          expect(outcome.report.prLink).toBe(ghPrLink)
        })
      })
    })
  })
})

describe("a direct-PR run opens its own PR after the checks", () => {
  test("pushes the branch and opens the PR instead of starting no-mistakes", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async (origin) => {
          const sha = await readyToCheck(dir, home)
          const kinds: Array<string> = []
          const outcome = await runDirectPrStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses)
          const bodyFile = join(home, "runs", "step-run-1", "pr-body.md")
          expect(kinds).toEqual(["implementer", "reviewer", "reviewer", "reviewer"])
          expect(outcome.report.endReason).toContain("The review turn failed, so the review did not pass")
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
          expect(outcome.signals).not.toContainEqual(expect.objectContaining({ name: "open-question" }))
          expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
          expect(outcome.steps).toContainEqual({ name: "pr", status: "passed" })
          expect(outcome.steps).not.toContainEqual(expect.objectContaining({ name: "no-mistakes" }))
          const body = await readFile(bodyFile, "utf8")
          expect(body).toContain("work")
          expect(body).toContain("after lint passed, without no-mistakes")
          expect(body).toContain("## Why\n\nDo the thing.")
        })
      })
    })
  })

  test("a test-only config records skipped checks instead of passed checks, also on resume", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await withOrigin(dir, async () => {
          const sha = await readyToCheck(dir, home)
          await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  test: forbidden-test-runner\n")
          const outcome = await runDirectPrStep(dir, home, sandboxResult(sha), async () => {
            throw new Error("a skipped test command must not start")
          })
          expect(outcome.steps).toContainEqual({ name: "checks", status: "skipped" })
          expect(outcome.report.checksRounds).toHaveLength(1)
          expect(outcome.report.checksRounds?.[0]).toMatchObject({ passed: false, checks: [], failed: [] })
          expect(outcome.report.completed).toBe(true)
          expect(runStatus(outcome.report)).toBe("completed")
          expect(outcome.report.endReason).toContain("No local checks ran.")
          expect(outcome.report.endReason).not.toContain("checks passed")
          expect(await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8")).toContain("without local checks or no-mistakes")
          const resumed = await runDirectPrResume(dir, home, sandboxResult(sha), async () => {
            throw new Error("a resumed skipped test command must not start")
          }, [])
          expect(resumed.steps).toContainEqual({ name: "checks", status: "skipped" })
          expect(resumed.report.checksRounds).toHaveLength(1)
          expect(resumed.report.completed).toBe(true)
          expect(runStatus(resumed.report)).toBe("completed")
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
          expect(outcome.run?.status).toBe("succeeded")
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
