import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { formatReport } from "../../packages/run/src/run-record"
import { cleanFinish, passedWithPr, readyToCheck, recordedNothing, runStep, sandboxResult, withHome, withRepo, type NoMistakesReply } from "./run-helpers"

const lintPasses = async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 })

const reviewedBy = (reviewer: string): NoMistakesReply => ({
  stdout: [
    "current_branch: orc/test",
    "other_branch_run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: completed",
    "  head: abc1234",
    "  pr: \"https://github.com/o/r/pull/7\"",
    "  findings: none",
    "  steps[2]{step,status,findings,duration_ms}:",
    "    review,completed,0,256023",
    "    ci,completed,0,118542",
    "  reviewer_agent: " + reviewer,
    "outcome: passed"
  ].join("\n") + "\n"
})

describe("runWithHistory names the reviewer that served the run", () => {
  test("the reviewer named in axi status lands in the result, no-mistakes.txt, the history and report.md rather than being dropped", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [passedWithPr, reviewedBy("pi/claude-bridge/claude-opus-5-5")])
        expect(outcome.report.noMistakes?.reviewer).toBe("pi/claude-bridge/claude-opus-5-5")
        expect(formatReport(outcome.report)).toContain("no-mistakes: passed, 0 findings, 0 gates answered, reviewed by pi/claude-bridge/claude-opus-5-5")
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("reviewer: pi/claude-bridge/claude-opus-5-5\n")
        expect(outcome.signals).toContainEqual({ name: "reviewer", value: "pi/claude-bridge/claude-opus-5-5" })
        const report = await readFile(join(home, "runs", "step-run-1", "report.md"), "utf8")
        expect(report).toContain("- reviewer: pi/claude-bridge/claude-opus-5-5\n")
      })
    })
  })

  test("a run whose status names no reviewer is not credited to one", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [passedWithPr, recordedNothing])
        expect(outcome.report.noMistakes?.reviewer).toBeNull()
        expect(formatReport(outcome.report)).toContain("no-mistakes: passed, 0 findings, 0 gates answered, reviewer not named\n")
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("reviewer: not named\n")
        expect(outcome.signals).not.toContainEqual(expect.objectContaining({ name: "reviewer" }))
      })
    })
  })
})
