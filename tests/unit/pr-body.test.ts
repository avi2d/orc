import { expect, test } from "bun:test"
import { prBody } from "../../packages/run/src/features/running-a-task/run-finish"

const twoFindings = [
  { id: "stale-cache", file: "src/cache.ts", line: 42, severity: "error", action: "Clear the cache on write.", description: "A write leaves the old value in the cache." },
  { id: "loose-type", file: "src/types.ts", line: null, severity: "warning", action: "Narrow the parameter to the three modes.", description: "The parameter accepts any string." }
] as const

test("a review with no findings says so in one line rather than leaving the body silent", () => {
  expect(prBody(["Add the cache"], ["lint"], { kind: "unfixed", findings: [] })).toBe(
    "- Add the cache\n\n---\n\norc opened this PR after lint passed, without no-mistakes.\n\nThe review found nothing.\n"
  )
})

test("two findings each list severity, file:line, action and description rather than dropping a field", () => {
  expect(prBody(["Add the cache"], ["lint"], { kind: "unfixed", findings: twoFindings })).toBe(
    "- Add the cache\n\n---\n\norc opened this PR after lint passed, without no-mistakes.\n\n" +
      "Open review findings:\n" +
      "- error `stale-cache` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "- warning `loose-type` at `src/types.ts`: The parameter accepts any string. Action: Narrow the parameter to the three modes.\n"
  )
})

test("a failed review turn is named rather than read as a review that found nothing", () => {
  const body = prBody(["Add the cache"], ["lint"], { kind: "failed" })
  expect(body).toContain("The review turn failed, so this PR lists no review findings.")
  expect(body).not.toContain("The review found nothing.")
})

test("each finding left by the orc fix loop carries its one reason line rather than standing bare", () => {
  const left = [
    { finding: twoFindings[0], reason: { kind: "repeat", round: 2 } },
    { finding: twoFindings[1], reason: { kind: "below-round-2-bar" } },
    { finding: { ...twoFindings[0], id: "late-leak" }, reason: { kind: "round-limit" } }
  ] as const
  expect(prBody(["Add the cache"], ["lint"], { kind: "left", findings: left })).toBe(
    "- Add the cache\n\n---\n\norc opened this PR after lint passed, without no-mistakes.\n\n" +
      "Open review findings:\n" +
      "- error `stale-cache` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "  - Left because it repeats a finding the fixer received in round 2.\n" +
      "- warning `loose-type` at `src/types.ts`: The parameter accepts any string. Action: Narrow the parameter to the three modes.\n" +
      "  - Left because its severity is below the round 2 bar, which fixes only errors.\n" +
      "- error `late-leak` at `src/cache.ts:42`: A write leaves the old value in the cache. Action: Clear the cache on write.\n" +
      "  - Left because the round limit was reached: the review after fix round 2 reported it.\n"
  )
})
