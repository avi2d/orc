import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type CheckSummary, checkTime, checksSummary, parseCheckIndex } from "../../../packages/herdr-app/src/checks"

const fixtureFile = join(import.meta.dir, "../../fixtures/herdr-agents/checks-log.txt")
const recorded = await readFile(fixtureFile, "utf8")
const parsedIndex = parseCheckIndex(await readFile(fixtureFile + ".index.json", "utf8"))
if (parsedIndex.kind !== "ok") throw new Error(parsedIndex.reason)
const fixtureIndex = parsedIndex.value
const fixtureSeconds = [21.4, 1.9, 4.2]

const indexedChecks = (text: string, status: Parameters<typeof checksSummary>[1], index: typeof fixtureIndex): ReadonlyArray<CheckSummary> => {
  const summary = checksSummary(text, status, index)
  if (summary === null) throw new Error("No check index")
  return summary
}

const recordedChecks = indexedChecks(recorded, "failed", fixtureIndex)
const interruptedIndex = fixtureIndex.map((entry) => entry.name === "e2e" ? { ...entry, result: null } : entry)
const cut = recorded.slice(0, recorded.indexOf("(fail)"))

const named = (checks: ReadonlyArray<CheckSummary>, name: string): CheckSummary => {
  const found = checks.find((check) => check.name === name)
  if (found === undefined) throw new Error(`no ${name} check`)
  return found
}

describe("the Summary view of a recorded checks log with a passed and a failed test check", () => {
  test("lists one row per indexed check, not one per output line", () => {
    expect(recordedChecks.map((check) => [check.name, check.outcome.kind])).toEqual([
      ["typecheck", "passed"],
      ["unit", "passed"],
      ["e2e", "failed"]
    ])
  })

  test("takes elapsed times from fixture index values instead of exit-line text", () => {
    expect(recordedChecks.map((check) => check.seconds)).toEqual(fixtureSeconds)
    expect(recordedChecks.map((check) => checkTime(check.seconds))).toEqual(["21.4s", "1.9s", "4.2s"])
  })

  test("folds the passed unit check with no lines instead of showing its passing output", () => {
    expect(named(recordedChecks, "unit").outcome).toEqual({ kind: "passed" })
  })

  test("lists the failed e2e test once with its error, not a failed check with no failing test", () => {
    const outcome = named(recordedChecks, "e2e").outcome
    if (outcome.kind !== "failed" || outcome.failure.kind !== "tests") throw new Error(`e2e reads as ${JSON.stringify(outcome)}`)
    expect(outcome.failure.failed.map((failed) => failed.name)).toEqual([
      "the trial pack > the scoped tarball keeps every file the orc tarball held instead of dropping the copied changelog"
    ])
    expect(outcome.failure.failed[0]?.error.at(0)).toBe("error: expect(received).toEqual(expected)")
    expect(outcome.failure.failed[0]?.error.at(-1)).toBe("      at <anonymous> (/work/orc/tests/e2e/pack.test.ts:210:47)")
    expect([outcome.failure.passCount, outcome.failure.failCount]).toEqual([3, 1])
  })

  test("shows an indexed check still writing as running instead of passed or failed", () => {
    expect(named(indexedChecks(cut, "running", interruptedIndex), "e2e").outcome).toEqual({ kind: "running" })
  })

  test("does not show an unfinished indexed check as running after the step fails", () => {
    const check = named(indexedChecks(cut, "failed", interruptedIndex), "e2e")
    expect(check.seconds).toBeNull()
    expect(check.outcome.kind).toBe("interrupted")
    if (check.outcome.kind !== "interrupted" || check.outcome.failure.kind !== "tail") throw new Error("No interrupted output")
    expect(check.outcome.failure.lines.at(-1)).toBe("      at <anonymous> (/work/orc/tests/e2e/pack.test.ts:210:47)")
  })

  test("uses the recorded range instead of splitting at a fake exit and header inside command output", () => {
    const head = "check lint: bun run lint\n"
    const output = "é 🚀\nexit 0: passed\n\ncheck fake: this is output\nactual failure"
    const text = head + output + "\nexit 1: failed\n"
    const index = parseCheckIndex(JSON.stringify({
      checks: [{ name: "lint", outputStart: head.length, result: { outputEnd: head.length + output.length, passed: false, seconds: 1.5 } }]
    }))
    if (index.kind !== "ok") throw new Error(index.reason)
    expect(indexedChecks(text, "failed", index.value)).toEqual([{
      name: "lint", seconds: 1.5, outcome: { kind: "failed", failure: { kind: "tail", lines: output.split("\n") } }
    }])
  })

  test("shows a failed indexed check that runs no tests by its last lines, not by its whole output", () => {
    const head = "check lint: bun run lint\n"
    const output = Array.from({ length: 30 }, (_, at) => `line ${at.toString()}`).join("\n")
    const lint = head + output + "\nexit 1: failed\n"
    const index = parseCheckIndex(JSON.stringify({
      checks: [{ name: "lint", outputStart: head.length, result: { outputEnd: head.length + output.length, passed: false, seconds: 1 } }]
    }))
    if (index.kind !== "ok") throw new Error(index.reason)
    const outcome = indexedChecks(lint, "failed", index.value).at(0)?.outcome
    if (outcome?.kind !== "failed" || outcome.failure.kind !== "tail") throw new Error(`lint reads as ${JSON.stringify(outcome)}`)
    expect(outcome.failure.lines).toHaveLength(20)
    expect(outcome.failure.lines.at(0)).toBe("line 10")
    expect(outcome.failure.lines.at(-1)).toBe("line 29")
  })

  test("does not invent check rows from log text when no boundaries were recorded", () => {
    expect(checksSummary(recorded, "failed", null)).toBeNull()
    const nested = "check test: bun test\nexit 0: passed\n\ncheck lint: printed by a test\nexit 1: failed\n"
    expect(checksSummary(nested, "failed", null)).toBeNull()
  })

  test("distinguishes an empty recorded index from missing boundaries instead of guessing rows", () => {
    const index = parseCheckIndex('{"checks":[]}')
    if (index.kind !== "ok") throw new Error(index.reason)
    expect(checksSummary(recorded, "failed", index.value)).toEqual([])
  })
})
