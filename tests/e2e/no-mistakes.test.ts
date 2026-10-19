import { describe, expect, test } from "bun:test"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { capturedSession, cleanFinish, commitOnBranch, passedWithPr, runStep, sandboxResult, sessionEnding, withHome, withRepo, type NoMistakesReply } from "./run-helpers"

const fixableGate: NoMistakesReply = {
  stdout: [
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: awaiting_approval",
    "  awaiting_agent: parked 2m10s",
    "  head: abc1234",
    "  pr: \"\"",
    "  findings[1]{id,severity,file,line,action,description}:",
    "    R7,warning,notes.md,,auto-fix,spelling",
    "gate: review"
  ].join("\n") + "\n"
}

const readyToCheck = async (dir: string, home: string): Promise<string> => {
  const sha = await commitOnBranch(dir, "orc/test")
  await capturedSession(home, sessionEnding(cleanFinish))
  await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
  return sha
}

describe("runWithHistory hands the branch to no-mistakes", () => {
  test("a clean run records the PR link, the finding count and the final result", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const taskPath = join(home, "runs", "step-run-1", "task.md")
        const workdir = await realpath(dir)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [passedWithPr])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.status).toBe("succeeded")
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toEqual(["axi run --intent-file " + taskPath, workdir])
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("no-mistakes result: passed")
        expect(text).toContain("PR: https://github.com/o/r/pull/7")
        expect(text).toContain("findings: 0")
        expect(text).toContain("gates answered: 0")
        expect(text).toContain("no-mistakes opened https://github.com/o/r/pull/7 and CI is green.")
        expect(outcome.signals).toContainEqual({ name: "finding-count", value: "0" })
        expect(outcome.signals).toContainEqual({ name: "result", value: "passed" })
        expect(outcome.signals).toContainEqual({ name: "gates-answered", value: "0" })
        expect(outcome.signals).toContainEqual({ name: "pr-link", value: "https://github.com/o/r/pull/7" })
      })
    })
  })
  test("a fixable finding is answered with fix, then the PR is recorded", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const taskPath = join(home, "runs", "step-run-1", "task.md")
        const workdir = await realpath(dir)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [fixableGate, passedWithPr])
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toEqual([
          "axi run --intent-file " + taskPath,
          workdir,
          "axi respond --action fix --findings R7",
          workdir
        ])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(1)
        expect(outcome.report.noMistakes?.findings.map((finding) => finding.id)).toEqual(["R7"])
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("R7 warning notes.md auto-fix spelling")
        expect(text).toContain("gates answered: 1")
      })
    })
  })

  test("a finding marked ask-user ends the run with no PR and names the finding", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
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
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [askUserGate])
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toHaveLength(2)
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.prLink).toBeNull()
        expect(outcome.report.noMistakes?.status).toBe("refused")
        expect(outcome.run?.prLink).toBeNull()
        expect(outcome.run?.status).toBe("failed")
        const reason = outcome.run?.endReason ?? ""
        expect(reason).toContain("R2")
        expect(reason).toContain("ask-user")
        expect(reason).toContain("No PR opens")
        expect(outcome.steps).toContainEqual({ name: "no-mistakes", status: "failed" })
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("no-mistakes result: refused")
        expect(text).toContain("R2")
      })
    })
  })
  test("a drive call with no gate or outcome reattaches without flags", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const taskPath = join(home, "runs", "step-run-1", "task.md")
        const workdir = await realpath(dir)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [{ stdout: "still working\n" }, passedWithPr])
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toEqual([
          "axi run --intent-file " + taskPath,
          workdir,
          "axi run",
          workdir
        ])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.prLink).toBe("https://github.com/o/r/pull/7")
      })
    })
  })

  test("a refused fix ends the run with a report naming the refusal", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [
          fixableGate,
          { stdout: "", stderr: "refused: protected path docs/launch.md needs his word", exitCode: 1 }
        ])
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toHaveLength(4)
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.prLink).toBeNull()
        expect(outcome.report.noMistakes?.status).toBe("refused")
        const reason = outcome.run?.endReason ?? ""
        expect(reason).toContain("protected path")
        expect(reason).toContain("No PR opens")
      })
    })
  })
})
