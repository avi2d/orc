import { describe, expect, test } from "bun:test"
import { approvalShown, approvalStage } from "../../../packages/herdr-app/src/approval-stage"

test("the approval card distinguishes every merge stage instead of showing a raw refusal", () => {
  expect(approvalStage("updating")).toBe("Updating from main")
  expect(approvalStage("checks-running")).toBe("Checks running")
  expect(approvalStage("conflicted")).toBe("Merge conflict")
  expect(approvalStage("check-failed")).toBe("Check failed")
  expect(approvalStage("merged")).toBe("Merged")
})

describe("the Approve card picks its button and notice", () => {
  const refusal = { kind: "failed", reason: "orc merge orc-48 exited 1: orc merge refused orc-48 and merged nothing" } as const

  test("a merge with no recorded stage yet reads Merging instead of a stage", () => {
    expect(approvalShown({ kind: "merging" }, undefined)).toEqual({ button: "Merging", notice: null })
  })

  test("a merge updating the branch reads Updating from main and then Checks running instead of Merging", () => {
    expect(approvalShown({ kind: "merging" }, { stage: "updating", detail: null })).toEqual({ button: "Updating from main", notice: null })
    expect(approvalShown({ kind: "merging" }, { stage: "checks-running", detail: null })).toEqual({ button: "Checks running", notice: null })
  })

  test("a new merge over a conflict an earlier attempt recorded reads Merging instead of the stale conflict", () => {
    expect(approvalShown({ kind: "merging" }, { stage: "conflicted", detail: "main" })).toEqual({ button: "Merging", notice: null })
    expect(approvalShown({ kind: "merging" }, { stage: "check-failed", detail: "ci/test" })).toEqual({ button: "Merging", notice: null })
  })

  test("a refused merge on a conflict names the conflict instead of the raw refusal", () => {
    expect(approvalShown(refusal, { stage: "conflicted", detail: "main" })).toEqual({ button: "Approve and merge", notice: "Merge conflict with main" })
  })

  test("a refused merge on a red check names the check instead of the raw refusal", () => {
    expect(approvalShown(refusal, { stage: "check-failed", detail: "ci/test" })).toEqual({ button: "Approve and merge", notice: "Check failed: ci/test" })
  })

  test("a refused merge with no failure stage shows the refusal instead of an in-progress stage", () => {
    expect(approvalShown(refusal, undefined).notice).toBe(refusal.reason)
    expect(approvalShown(refusal, { stage: "checks-running", detail: null }).notice).toBe(refusal.reason)
  })

  test("a card with no merge of its own shows no recorded failure instead of a stale one from an earlier head", () => {
    expect(approvalShown(null, { stage: "conflicted", detail: "main" })).toEqual({ button: "Approve and merge", notice: null })
  })
})
