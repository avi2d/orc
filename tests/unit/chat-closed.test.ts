import { describe, expect, test } from "bun:test"
import { type ClosedTask, closedLine } from "../../packages/run/src/features/chat/chat-closed"
import { fullPrUrl } from "../../packages/run/src/entities/backlog/index"

const url = "https://github.com/acme/orc/pull/42"

const closed = (fields: Partial<ClosedTask>): ClosedTask => ({
  id: "orc-1",
  title: "Fix the typo",
  kind: "ship",
  status: "closed",
  hold: null,
  parked: null,
  outcome: "done",
  reason: "",
  pr: url,
  report: null,
  answer: null,
  postedAt: null,
  ...fields
})

describe("closed chat line", () => {
  test("a done ship names its full PR address", () => {
    expect(closedLine(closed({}))).toBe("orc-1 Fix the typo closed done, PR " + url)
  })
  test("a failed ship with a PR names its full PR address", () => {
    expect(closedLine(closed({ outcome: "failed", reason: "CI is red" }))).toBe("orc-1 Fix the typo closed failed: CI is red, PR " + url)
  })
  test("a stopped task with a PR names its full PR address", () => {
    expect(closedLine(closed({ outcome: "stopped", reason: "the captain stopped orc-1" }))).toBe("orc-1 Fix the typo closed stopped: the captain stopped orc-1, PR " + url)
  })
  test("a dropped task with a PR names its full PR address", () => {
    expect(closedLine(closed({ outcome: "dropped", reason: "not needed" }))).toBe("orc-1 Fix the typo closed dropped: not needed, PR " + url)
  })
  test("a scout names its report and its full PR address", () => {
    expect(closedLine(closed({ kind: "scout", report: "/runs/orc-1/report.md" }))).toBe("orc-1 Fix the typo closed done, report /runs/orc-1/report.md, PR " + url)
  })
  test("a ship without a PR says so", () => {
    expect(closedLine(closed({ pr: null }))).toBe("orc-1 Fix the typo closed done, with no PR")
  })
})

describe("stored PR address", () => {
  test("keeps only a full https pull request URL", () => {
    expect(fullPrUrl(url)).toBe(url)
    expect(fullPrUrl("42")).toBeNull()
    expect(fullPrUrl("#42")).toBeNull()
    expect(fullPrUrl("orc/orc-1")).toBeNull()
    expect(fullPrUrl(undefined)).toBeNull()
  })
})
