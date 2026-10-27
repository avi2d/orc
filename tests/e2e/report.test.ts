import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { formatReport } from "../../packages/run/src/run-record"
import {
  capturedSession,
  cleanFinish,
  commitOnBranch,
  passedWithPr,
  recordedNothing,
  runStep,
  sandboxResult,
  sessionEnding,
  withHome,
  withRepo,
  type NoMistakesReply
} from "./run-helpers"

describe("the run report", () => {
  test("a green run lands report.md beside its evidence with the task, PR and signals", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [passedWithPr, recordedNothing])
        expect(outcome.report.completed).toBe(true)
        const runDir = join(home, "runs", "step-run-1")
        const report = await readFile(join(runDir, "report.md"), "utf8")
        expect(report).toContain("# Run report step-run-1")
        expect(report).toContain("Do the thing.")
        expect(report).toContain("Task: file://" + runDir + "/task.md")
        expect(report).toContain("PR: https://github.com/o/r/pull/7")
        expect(report).toContain("## Steps")
        expect(report).toContain("- implement: passed")
        expect(report).toContain("- checks round 1: passed file://" + runDir + "/session/checks-1.txt")
        expect(report).toContain("- no-mistakes: passed")
        expect(report).toContain("## Evidence")
        expect(report).toContain("- task: file://" + runDir + "/task.md")
        expect(report).toContain("- implement: file://" + runDir + "/implement-1.md")
        expect(report).toContain("## Signals")
        expect(report).toContain("commit-count")
        expect(report).toContain("## Result")
        const terminal = formatReport(outcome.report)
        expect(terminal).toContain("run folder: file://" + runDir)
        expect(terminal).toContain("report: file://" + runDir + "/report.md")
        expect(terminal).toMatch(/^agent file: file:\/\/\/\S+\/bundled\/implementer\.md \(bundled\)$/m)
        expect(terminal).toMatch(/^session file: file:\/\/\/\S+\.jsonl$/m)
        expect(terminal).toContain("pr: https://github.com/o/r/pull/7")
      })
    })
  })

  test("a refused run still lands report.md naming each refused finding", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
        const askUserGate: NoMistakesReply = {
          stdout: [
            "run:",
            "  id: \"01STUB\"",
            "  branch: orc/test",
            "  status: awaiting_approval",
            "  awaiting_agent: parked 2m10s",
            "  head: abc1234",
            "  pr: \"\"",
            "  findings[1]{id,severity,file,line,action,description}:",
            "    R2,error,b.go,,ask-user,changes product behavior",
            "gate: review"
          ].join("\n") + "\n"
        }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [askUserGate, recordedNothing])
        expect(outcome.report.completed).toBe(false)
        const report = await readFile(join(home, "runs", "step-run-1", "report.md"), "utf8")
        expect(report).toContain("# Run report step-run-1")
        expect(report).toContain("Status: no-mistakes refused, no PR")
        expect(report).toContain("- no-mistakes: refused at review")
        expect(report).toContain("## Findings")
        expect(report).toContain("R2")
        expect(report).toContain("ask-user")
        expect(report).toContain("changes product behavior")
        expect(report).toContain("## Result")
      })
    })
  })
})
