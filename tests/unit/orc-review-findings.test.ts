import { expect, test } from "bun:test"
import { Result } from "effect"
import { decodeOrcReviewFindings } from "../../packages/run/src/features/running-a-task/review-outcome"

test("orc review accepts all specified severities rather than the direct-PR severity vocabulary", () => {
  const findings = (["error", "warning", "info"] as const).map((severity) => ({ id: severity, file: "src/a.ts", line: 1, severity, action: "Fix it.", description: "The change breaks the contract." }))
  const decoded = decodeOrcReviewFindings(JSON.stringify(findings))
  expect(Result.isSuccess(decoded)).toBe(true)
  if (Result.isSuccess(decoded)) expect(decoded.success).toEqual(findings)
})
