import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { runOrc } from "./chat-helpers"
import { closedWithPr, ghCalls, head, newHead, passed, prUrl, type Rollup, stubGh, withMergeFixture } from "./merge-helpers"

const running = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-02T10:05:00Z" })

describe("ORC_MERGE_POLL_SECONDS", () => {
  test("sets the first wait instead of the fixed 1, 2 and 4 seconds", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, afterUpdate: [{ head, checks: [passed("lint"), passed("test")] }, { head: newHead, checks: [passed("lint"), running("test")] }, { head: newHead, checks: [passed("lint"), passed("test")] }] })
      const started = Date.now()
      const merged = await runOrc({ ...fixture, env: { ...fixture.env, ORC_MERGE_POLL_SECONDS: "0.05" } }, ["merge", "orc-1"])
      const elapsed = Date.now() - started
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      const calls = (await readFile(ghCalls(fixture), "utf8")).split("\n")
      expect(calls.filter((line) => line.startsWith("pr view"))).toHaveLength(4)
      expect(calls.filter((line) => line.startsWith("pr merge"))).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
      expect(elapsed).toBeLessThan(4000)
    })
  }, 60_000)

  test("a value that is not a number of seconds is refused before orc reads the PR instead of read as zero", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1 })
      const merged = await runOrc({ ...fixture, env: { ...fixture.env, ORC_MERGE_POLL_SECONDS: "0" } }, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stderr).toContain("ORC_MERGE_POLL_SECONDS is 0")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)
})
