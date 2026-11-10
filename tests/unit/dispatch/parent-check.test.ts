import { describe, expect, test } from "bun:test"
import { endingFromResult } from "../../../packages/run/src/dispatch/runner-result"
import { checkPassed } from "../../../packages/run/src/report-run"

const at = "2026-10-27T10:02:00.000Z"
const report = "/runs/run-1/agent-report.md"
const failedCheck = { id: "run-1", status: "failed" as const, prLink: null, endReason: "the final check did not end its report with verdict: pass", openQuestions: [], report }

describe("a parent's final check", () => {
  test("passes only when the last line of the report is the pass verdict", () => {
    expect(checkPassed("# Check\n\nAll three criteria hold.\n\nverdict: pass\n\n")).toBe(true)
  })

  test("a pass verdict above a later line fails instead of passing", () => {
    expect(checkPassed("verdict: pass\n\nOne criterion does not hold.\n")).toBe(false)
    expect(checkPassed("# Check\n\nVerdict: Pass")).toBe(false)
    expect(checkPassed("verdict: fail\n")).toBe(false)
    expect(checkPassed("")).toBe(false)
  })

  test("a failed check that wrote its report closes the parent failed instead of done", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: at, ended: at, reason: "orc exited 1", run: failedCheck }, "parent")).toEqual({
      kind: "close", outcome: "failed", reason: failedCheck.endReason, pr: null, report
    })
  })

  test("a passed check closes the parent done with its report instead of failed", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "succeeded", started: at, ended: at, run: { ...failedCheck, status: "succeeded" as const, endReason: null } }, "parent")).toEqual({
      kind: "close", outcome: "done", reason: "the run wrote its report", pr: null, report
    })
  })
})
