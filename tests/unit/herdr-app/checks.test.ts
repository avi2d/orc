import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type CheckSummary, checkTime, checksSummary, parseCheckIndex } from "../../../packages/herdr-app/src/checks"

const recorded = await readFile(join(import.meta.dir, "../../fixtures/herdr-agents/checks-log.txt"), "utf8")

const named = (checks: ReadonlyArray<CheckSummary>, name: string): CheckSummary => {
  const found = checks.find((check) => check.name === name)
  if (found === undefined) throw new Error(`no ${name} check`)
  return found
}

describe("the Summary view of a recorded checks log with a passed and a failed test check", () => {
  test("lists one row per check with its mark and time, not one per output line", () => {
    expect(checksSummary(recorded, "failed").map((check) => [check.name, check.outcome.kind, checkTime(check.seconds)])).toEqual([
      ["typecheck", "passed", "21.4s"],
      ["unit", "passed", "1.9s"],
      ["e2e", "failed", "4.2s"]
    ])
  })

  test("folds the passed unit check with no lines instead of showing its passing output", () => {
    expect(named(checksSummary(recorded, "failed"), "unit").outcome).toEqual({ kind: "passed" })
  })

  test("lists the failed e2e test once with its error, not a failed check with no failing test", () => {
    const outcome = named(checksSummary(recorded, "failed"), "e2e").outcome
    if (outcome.kind !== "failed" || outcome.failure.kind !== "tests") throw new Error(`e2e reads as ${JSON.stringify(outcome)}`)
    expect(outcome.failure.failed.map((failed) => failed.name)).toEqual([
      "the trial pack > the scoped tarball keeps every file the orc tarball held instead of dropping the copied changelog"
    ])
    expect(outcome.failure.failed[0]?.error.at(0)).toBe("error: expect(received).toEqual(expected)")
    expect(outcome.failure.failed[0]?.error.at(-1)).toBe("      at <anonymous> (/work/orc/tests/e2e/pack.test.ts:210:47)")
    expect([outcome.failure.passCount, outcome.failure.failCount]).toEqual([3, 1])
  })

  test("shows a check still writing as running instead of passed or failed", () => {
    const cut = recorded.slice(0, recorded.indexOf("(fail)"))
    expect(named(checksSummary(cut, "running"), "e2e").outcome).toEqual({ kind: "running" })
  })

  test("does not show a check with no exit as running after the step fails", () => {
    const cut = recorded.slice(0, recorded.indexOf("(fail)"))
    expect(named(checksSummary(cut, "failed"), "e2e").outcome.kind).toBe("interrupted")
  })

  test("uses the recorded range instead of splitting at a fake exit and header inside command output", () => {
    const head = "check lint: bun run lint\n"
    const output = "é 🚀\nexit 0: passed\n\ncheck fake: this is output\nactual failure"
    const text = head + output + "\nexit 1: failed\n"
    const index = parseCheckIndex(JSON.stringify({
      checks: [{ name: "lint", outputStart: head.length, result: { outputEnd: head.length + output.length, passed: false, seconds: 1.5 } }]
    }))
    if (index.kind !== "ok") throw new Error(index.reason)
    expect(checksSummary(text, "failed", index.value)).toEqual([{
      name: "lint", seconds: 1.5, outcome: { kind: "failed", failure: { kind: "tail", lines: output.split("\n") } }
    }])
  })

  test("shows a failed check that runs no tests by its last lines, not by its whole output", () => {
    const lint = "check lint: bun run lint\n" + Array.from({ length: 30 }, (_, at) => `line ${at.toString()}`).join("\n") + "\nexit 1: failed\n"
    const outcome = checksSummary(lint, "failed").at(0)?.outcome
    if (outcome?.kind !== "failed" || outcome.failure.kind !== "tail") throw new Error(`lint reads as ${JSON.stringify(outcome)}`)
    expect(outcome.failure.lines).toHaveLength(20)
    expect(outcome.failure.lines.at(-1)).toBe("line 29")
  })

  test("keeps a check header printed inside a check's output as that check's output, not a new check", () => {
    const nested = "check test: bun test\ncheck lint: printed by a test\nexit 0: passed in 1.0s\n"
    expect(checksSummary(nested, "passed").map((check) => check.name)).toEqual(["test"])
  })
})
