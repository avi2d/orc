import { expect, test } from "bun:test"
import { approvalStage } from "../../../packages/herdr-app/src/approval-stage"

test("the approval card distinguishes every merge stage instead of showing a raw refusal", () => {
  expect(approvalStage("updating")).toBe("Updating from main")
  expect(approvalStage("checks-running")).toBe("Checks running")
  expect(approvalStage("conflicted")).toBe("Merge conflict")
  expect(approvalStage("check-failed")).toBe("Check failed")
  expect(approvalStage("merged")).toBe("Merged")
})
