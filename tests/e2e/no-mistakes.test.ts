import { describe, expect, test } from "bun:test"
import { access, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { capturedSession, checksPassedWhileMonitoring, cleanFinish, commitOnBranch, git, passedWithPr, recordedNothing, runStep, sandboxResult, sessionEnding, withHome, withRepo, type NoMistakesReply } from "./run-helpers"

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

const fixReviewGate: NoMistakesReply = {
  stdout: [
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: running",
    "  awaiting_agent: parked 0m05s",
    "  head: def5678",
    "  pr: \"\"",
    "gate:",
    "  step: review",
    "  status: fix_review",
    "findings[1]{id,severity,file,line,action,description}:",
    "  R7,warning,notes.md,,auto-fix,spelling"
  ].join("\n") + "\n"
}

const finalOutcome = (status: string, outcome: string, pr: string): NoMistakesReply => ({
  stdout: [
    "run:",
    "  id: \"01STUB\"",
    "  branch: orc/test",
    "  status: " + status,
    "  head: abc1234",
    "  pr: \"" + pr + "\"",
    "outcome: " + outcome
  ].join("\n") + "\n",
  exitCode: outcome === "failed" || outcome === "cancelled" ? 1 : 0
})

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

const lintPasses = async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 })

const nmCallLines = (calls: string): ReadonlyArray<string> => calls.split("\n").filter((line) => line !== "")

const axiCalls = (calls: string): ReadonlyArray<string> => nmCallLines(calls).filter((line) => line.startsWith("axi "))

const statusLookup = "axi status --run 01STUB"

const waitExpired: NoMistakesReply = {
  stdout: "error: wait of 8m0s elapsed while driving the run\nhelp[1]:\n  Run `no-mistakes axi status` to inspect the run, then reattach\n",
  exitCode: 1
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
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [passedWithPr, recordedNothing])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.status).toBe("succeeded")
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toEqual(["axi run --intent-file " + taskPath, workdir, statusLookup, workdir])
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
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [fixableGate, passedWithPr, recordedNothing])
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toEqual([
          "axi run --intent-file " + taskPath,
          workdir,
          "axi respond --action fix --findings R7",
          workdir,
          statusLookup,
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
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [askUserGate, recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toEqual(["axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"), statusLookup])
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
  test("an open review question is answered verbatim before any gate response", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const questionGate: NoMistakesReply = {
          stdout: [
            "run:",
            "  id: \"01STUB\"",
            "  branch: orc/test",
            "  status: awaiting_approval",
            "  awaiting_agent: parked 2m10s",
            "  head: abc1234",
            "  pr: \"\"",
            "  findings[1]{id,severity,file,line,action,description}:",
            "    question-3,info,,,ask-user,Which scope should the report cover?",
            "gate: review"
          ].join("\n") + "\n"
        }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [questionGate, fixableGate, passedWithPr, recordedNothing], [{ question: "question-3", answer: "Use the wide scope" }])
        const calls = axiCalls(outcome.nmCalls)
        expect(calls).toContain("axi answer --question question-3 --answer Use the wide scope")
        expect(calls.indexOf("axi answer --question question-3 --answer Use the wide scope")).toBeLessThan(calls.findIndex((line) => line.startsWith("axi respond")))
        expect(calls.filter((line) => line.startsWith("axi respond")).some((line) => line.includes("question-3"))).toBe(false)
        expect(outcome.nmCalls).not.toContain("--ignore question-3")
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(2)
      })
    })
  })
  test("an open review question without an answer refuses naming the question and sends no response", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const questionGate: NoMistakesReply = {
          stdout: [
            "run:",
            "  id: \"01STUB\"",
            "  branch: orc/test",
            "  status: awaiting_approval",
            "  awaiting_agent: parked 2m10s",
            "  head: abc1234",
            "  pr: \"\"",
            "  findings[1]{id,severity,file,line,action,description}:",
            "    question-3,info,,,ask-user,Which scope should the report cover?",
            "gate: review"
          ].join("\n") + "\n"
        }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [questionGate, recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toEqual(["axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"), statusLookup])
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.noMistakes?.status).toBe("refused")
        const reason = outcome.run?.endReason ?? ""
        expect(reason).toContain("question-3")
        expect(reason).toContain("Which scope should the report cover?")
        expect(reason).toContain("--answer question-3=")
      })
    })
  })
  test("an omitted review question without an answer is refused alongside rendered ones", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const questionGate: NoMistakesReply = {
          stdout: [
            "run:",
            "  id: \"01STUB\"",
            "  branch: orc/test",
            "  status: awaiting_approval",
            "  awaiting_agent: parked 2m10s",
            "  head: abc1234",
            "  pr: \"\"",
            "  findings[2]{id,severity,file,line,action,description}:",
            "    question-3,info,,,ask-user,Which scope should the report cover?",
            "    question-4,info,,,ask-user,Which retries are allowed?",
            "review-questions-omitted: 1 further review question(s) are open and have no row of their own. This gate releases only once EVERY open question is answered, so answer these by id as well, with: no-mistakes axi answer --question <id> --answer \"<your answer>\". Omitted question ids: question-5",
            "gate: review"
          ].join("\n") + "\n"
        }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [questionGate, recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toEqual(["axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"), statusLookup])
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.noMistakes?.status).toBe("refused")
        const reason = outcome.run?.endReason ?? ""
        expect(reason).toContain("question-3")
        expect(reason).toContain("question-4")
        expect(reason).toContain("question-5")
        expect(reason).toContain("Which scope should the report cover?")
        expect(reason).toContain("Which retries are allowed?")
        expect(reason).toContain("--answer question-3=")
        expect(reason).toContain("--answer question-5=")
      })
    })
  })
  test("rendered and omitted review questions are answered verbatim in order", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const questionGate: NoMistakesReply = {
          stdout: [
            "run:",
            "  id: \"01STUB\"",
            "  branch: orc/test",
            "  status: awaiting_approval",
            "  awaiting_agent: parked 2m10s",
            "  head: abc1234",
            "  pr: \"\"",
            "  findings[2]{id,severity,file,line,action,description}:",
            "    question-3,info,,,ask-user,Which scope should the report cover?",
            "    question-4,info,,,ask-user,Which retries are allowed?",
            "review-questions-omitted: 1 further review question(s) are open and have no row of their own. This gate releases only once EVERY open question is answered, so answer these by id as well, with: no-mistakes axi answer --question <id> --answer \"<your answer>\". Omitted question ids: question-5",
            "gate: review"
          ].join("\n") + "\n"
        }
        const answered: NoMistakesReply = { stdout: "answered\n" }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [questionGate, answered, answered, fixableGate, passedWithPr, recordedNothing], [
          { question: "question-3", answer: "Use the wide scope" },
          { question: "question-4", answer: "Allow both retries" },
          { question: "question-5", answer: "Focus on the report" }
        ])
        const calls = axiCalls(outcome.nmCalls)
        expect(calls.filter((line) => line.startsWith("axi answer"))).toEqual([
          "axi answer --question question-3 --answer Use the wide scope",
          "axi answer --question question-4 --answer Allow both retries",
          "axi answer --question question-5 --answer Focus on the report"
        ])
        expect(calls.findIndex((line) => line.startsWith("axi respond"))).toBeGreaterThan(calls.findIndex((line) => line.startsWith("axi answer")))
        expect(calls.filter((line) => line.startsWith("axi respond")).some((line) => line.includes("question-"))).toBe(false)
        expect(outcome.nmCalls).not.toContain("--ignore question-")
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(2)
      })
    })
  })
  test("a drive call with no gate or outcome reattaches without flags", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const taskPath = join(home, "runs", "step-run-1", "task.md")
        const workdir = await realpath(dir)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [{ stdout: "still working\n" }, passedWithPr, recordedNothing])
        expect(outcome.nmCalls.split("\n").filter((line) => line !== "")).toEqual([
          "axi run --intent-file " + taskPath,
          workdir,
          "axi run",
          workdir,
          statusLookup,
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
          { stdout: "", stderr: "refused: protected path docs/launch.md needs your word", exitCode: 1 },
          recordedNothing
        ])
        expect(axiCalls(outcome.nmCalls)).toEqual(["axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"), "axi respond --action fix --findings R7", statusLookup])
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.prLink).toBeNull()
        expect(outcome.report.noMistakes?.status).toBe("refused")
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(0)
        const reason = outcome.run?.endReason ?? ""
        expect(reason).toContain("protected path")
        expect(reason).toContain("No PR opens")
      })
    })
  })

  test("checks-passed while the CI monitor keeps watching records the ready PR without reattaching", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [checksPassedWhileMonitoring, recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toEqual(["axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"), statusLookup])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.status).toBe("passed")
        expect(outcome.run?.prLink).toBe("https://github.com/o/r/pull/7")
      })
    })
  })

  test("passed-with-skips keeps the PR link but never claims green CI", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [finalOutcome("completed", "passed-with-skips", "https://github.com/o/r/pull/7"), recordedNothing])
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.report.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.endReason).toContain("passed-with-skips")
        expect(outcome.run?.endReason).not.toContain("CI is green")
        expect(outcome.run?.endReason).not.toContain("No PR opens")
      })
    })
  })

  test("a failed outcome exiting 1 after the PR opened keeps the checks, the PR and no-mistakes.txt", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [finalOutcome("failed", "failed", "https://github.com/o/r/pull/7"), recordedNothing])
        expect(outcome.report.checksRounds).toHaveLength(1)
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.run?.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.steps).toContainEqual({ name: "no-mistakes", status: "failed" })
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("PR: https://github.com/o/r/pull/7")
        expect(text).toContain("outcome failed")
      })
    })
  })

  test("a fix answered with a failed pipeline is recorded as failed, not as a refused fix", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [fixableGate, finalOutcome("failed", "failed", ""), recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toHaveLength(3)
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(1)
        expect(outcome.run?.endReason).not.toContain("refused the fix")
      })
    })
  })

  test("a start refused with an error on stdout keeps the checks and names the error", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [
          { stdout: "error: no-mistakes is not initialized in this repository\nhelp[1]:\n  Run `no-mistakes init`\n", exitCode: 1 }
        ])
        expect(outcome.report.checksRounds).toHaveLength(1)
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.run?.endReason).toContain("not initialized")
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("no-mistakes result: failed")
      })
    })
  })

  test("a no-mistakes too old for --intent-file names the release orc needs", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [
          { stdout: "", stderr: "unknown flag: --intent-file\n", exitCode: 1 }
        ])
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.run?.endReason).toContain("no-mistakes refused to start: unknown flag: --intent-file")
        expect(outcome.run?.endReason).toContain("v1.90.0 or later")
        expect(outcome.run?.endReason).toContain("ORC_NO_MISTAKES_BIN")
      })
    })
  })

  test("the fix review after a requested fix is accepted with approve", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [fixableGate, fixReviewGate, checksPassedWhileMonitoring, recordedNothing])
        expect(nmCallLines(outcome.nmCalls).filter((line) => line.startsWith("axi "))).toEqual([
          "axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"),
          "axi respond --action fix --findings R7",
          "axi respond --action approve",
          statusLookup
        ])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(2)
      })
    })
  })

  test("a gate with an auto-fix and a no-op finding fixes the one and declines the other", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const mixedGate: NoMistakesReply = { stdout: fixableGate.stdout.replace("findings[1]", "findings[2]").replace("auto-fix,spelling", "auto-fix,spelling\n    R8,info,notes.md,,no-op,style note") }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [mixedGate, checksPassedWhileMonitoring, recordedNothing])
        expect(nmCallLines(outcome.nmCalls)).toContain("axi respond --action fix --findings R7 --ignore R8")
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.findings.map((finding) => finding.id)).toEqual(["R7", "R8"])
      })
    })
  })

  test("findings each step recorded are read from axi logs, and fix summaries are not findings", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const withFixes: NoMistakesReply = {
          stdout: checksPassedWhileMonitoring.stdout + "fixes[2]{step,summary}:\n  lint,removed an unused import\n  lint,sorted the imports\n"
        }
        const status: NoMistakesReply = {
          stdout: [
            "run:",
            "  id: \"01STUB\"",
            "  status: running",
            "  pr: \"https://github.com/o/r/pull/7\"",
            "  steps[3]{step,status,findings,duration_ms}:",
            "    review,completed,0,3928",
            "    lint,completed,2,812",
            "    ci,running,0,0"
          ].join("\n") + "\n"
        }
        const lintLog: NoMistakesReply = {
          stdout: [
            "step: lint",
            "run: \"01STUB\"",
            "findings[2]{id,severity,file,action,carried,description}:",
            "  L1,warning,src/a.ts,auto-fix,,unused import",
            "  L2,info,src/b.ts,auto-fix,,\"imports out of order, fixed\""
          ].join("\n") + "\n"
        }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [withFixes, status, lintLog])
        expect(axiCalls(outcome.nmCalls)).toEqual([
          "axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"),
          statusLookup,
          "axi logs --run 01STUB --step lint"
        ])
        expect(outcome.report.noMistakes?.findings.map((finding) => finding.id)).toEqual(["L1", "L2"])
        expect(outcome.signals).toContainEqual({ name: "finding-count", value: "2" })
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("findings: 2")
        expect(text).toContain("L1 warning src/a.ts auto-fix unused import")
        expect(text).toContain("L2 info src/b.ts auto-fix imports out of order, fixed")
      })
    })
  })

  test("a start whose wait elapses reattaches instead of reporting a refusal", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [waitExpired, checksPassedWhileMonitoring, recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toEqual(["axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"), "axi run", statusLookup])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(0)
      })
    })
  })

  test("a response whose wait elapses reattaches without answering the gate again", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [fixableGate, waitExpired, checksPassedWhileMonitoring, recordedNothing])
        expect(axiCalls(outcome.nmCalls)).toEqual([
          "axi run --intent-file " + join(home, "runs", "step-run-1", "task.md"),
          "axi respond --action fix --findings R7",
          "axi run",
          statusLookup
        ])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.noMistakes?.gatesAnswered).toBe(1)
      })
    })
  })

  test("repository git config a passing check wrote runs no program when no-mistakes calls git", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const marker = join(home, "fsmonitor-ran")
        const fsmonitor = join(home, "fsmonitor.sh")
        await writeFile(fsmonitor, "#!/bin/sh\ntouch " + marker + "\n", { mode: 0o755 })
        const checkWritesConfig = async () => {
          git(dir, ["config", "core.fsmonitor", fsmonitor])
          return { stdout: "lint ok", stderr: "", exitCode: 0 }
        }
        await runStep(dir, home, sandboxResult(sha, cleanFinish), checkWritesConfig, [passedWithPr, recordedNothing])
        expect(await exists(marker)).toBe(false)
      })
    })
  })

  test("a logs read that fails after a step recorded findings reports the gap instead of zero findings", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const lintRecordedTwo: NoMistakesReply = { stdout: recordedNothing.stdout.replace("steps[2]", "steps[3]").replace("    ci,running", "    lint,completed,2,812\n    ci,running") }
        const logsFail: NoMistakesReply = { stdout: "error: cannot read the lint step log\n", exitCode: 1 }
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [checksPassedWhileMonitoring, lintRecordedTwo, logsFail])
        expect(axiCalls(outcome.nmCalls)).toContain("axi logs --run 01STUB --step lint")
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.run?.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.endReason).toContain("could not read the findings")
        expect(outcome.run?.endReason).toContain("cannot read the lint step log")
        const text = await readFile(join(home, "runs", "step-run-1", "no-mistakes.txt"), "utf8")
        expect(text).toContain("no-mistakes result: failed")
      })
    })
  })

  test("a status read that fails reports the gap instead of zero findings", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await readyToCheck(dir, home)
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), lintPasses, [checksPassedWhileMonitoring, { stdout: "", stderr: "daemon unreachable", exitCode: 1 }])
        expect(outcome.report.noMistakes?.status).toBe("failed")
        expect(outcome.report.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.run?.endReason).toContain("daemon unreachable")
      })
    })
  })
})
