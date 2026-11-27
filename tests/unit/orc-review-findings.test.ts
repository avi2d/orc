import { expect, test } from "bun:test"
import { Result } from "effect"
import { decodeOrcReviewFindings } from "../../packages/run/src/features/running-a-task/review-outcome"

test("orc review accepts all specified severities rather than the direct-PR severity vocabulary", () => {
  const findings = (["error", "warning", "info"] as const).map((severity) => ({ id: severity, topic: severity + "-topic", file: "src/a.ts", line: 1, severity, action: "Fix it.", description: "The change breaks the contract." }))
  const decoded = decodeOrcReviewFindings(JSON.stringify(findings))
  expect(Result.isSuccess(decoded)).toBe(true)
  if (Result.isSuccess(decoded)) expect(decoded.success).toEqual(findings)
})

test("orc review names malformed findings rather than accepting an empty review", () => {
  const decoded = decodeOrcReviewFindings('[{"id":"bad"}]')
  expect(Result.isFailure(decoded)).toBe(true)
  if (Result.isFailure(decoded)) expect(decoded.failure.name).toBe("OrcReviewOutputError")
})
