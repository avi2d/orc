import { expect, test } from "bun:test"
import { prBody } from "../../packages/run/src/features/running-a-task/run-finish"

const twoFindings = [
  { id: "stale-cache", file: "src/cache.ts", line: 42, severity: "error", action: "Clear the cache on write.", description: "A write leaves the old value in the cache." },
  { id: "loose-type", file: "src/types.ts", line: null, severity: "warning", action: "Narrow the parameter to the three modes.", description: "The parameter accepts any string." }
] as const

test("a review with no findings says so in one line rather than leaving the body silent", () => {
  expect(prBody(["Add the cache"], ["lint"], { status: "passed", findings: [], file: "review.json" })).toBe(
    "- Add the cache\n\n---\n\norc opened this PR after lint passed, without no-mistakes.\n\nThe review found nothing.\n"
  )
})

test("two findings each list severity, file:line, action and description rather than dropping a field", () => {
  expect(prBody(["Add the cache"], ["lint"], { status: "passed", findings: twoFindings, file: "review.json" })).toBe(
    "- Add the cache\n\n---\n\norc opened this PR after lint passed, without no-mistakes.\n\n" +
      "Open review findings:\n" +
      "- error `stale-cache` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "- warning `loose-type` at `src/types.ts`: The parameter accepts any string. Action: Narrow the parameter to the three modes.\n"
  )
})

test("a failed review turn is named rather than read as a review that found nothing", () => {
  const body = prBody(["Add the cache"], ["lint"], { status: "failed", reason: "the reply held no JSON" })
  expect(body).toContain("The review turn failed, so this PR lists no review findings.")
  expect(body).not.toContain("The review found nothing.")
})
