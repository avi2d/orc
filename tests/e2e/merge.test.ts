import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { closeTask, ranClosing, runOrc, sessionFor } from "./chat-helpers"
import { closedWithPr, type Forge, ghCalls, head, mergeCalls, passed, prUrl, stubGh, taskFile, withMergeFixture } from "./merge-helpers"

const refusedMerge = async (forge: Forge, expected: string): Promise<void> => {
  await withMergeFixture(async (fixture) => {
    await closedWithPr(fixture)
    await stubGh(fixture, forge)
    const merged = await runOrc(fixture, ["merge", "orc-1"])
    expect(merged.exitCode).not.toBe(0)
    expect(merged.stderr).toContain("orc merge refused orc-1 and merged nothing: " + prUrl)
    expect(merged.stderr).toContain(expected)
    expect(await mergeCalls(fixture)).toEqual([])
    expect(await taskFile(fixture)).not.toContain("merged_at")
  })
}

describe("orc merge refuses a PR the guard would not land", () => {
  test("a closed PR is refused instead of merged", async () => {
    await refusedMerge({ state: "CLOSED" }, "is closed, not open")
  }, 60_000)

  test("an already merged PR is refused instead of merged again", async () => {
    await refusedMerge({ state: "MERGED" }, "is merged, not open")
  }, 60_000)

  test("a red check is refused instead of merged", async () => {
    await refusedMerge({ checks: [passed("lint"), { __typename: "CheckRun", workflowName: "ci", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:00:00Z" }] }, "the check ci/test is red")
  }, 60_000)

  test("the same job name in two workflows with one red is refused instead of merged", async () => {
    await refusedMerge({ checks: [{ __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/11/job/1", name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:00:10Z" }, { __typename: "CheckRun", workflowName: "release", detailsUrl: "https://github.com/acme/orc/actions/runs/12/job/1", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:00:12Z" }] }, "the check ci/build is red")
  }, 60_000)

  test("the same job from two events with one red is refused instead of merged", async () => {
    await refusedMerge({ checks: [{ __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/21/job/1", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:00:01Z" }, { __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/22/job/1", name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:00:03Z" }] }, "the check ci/test is red")
  }, 60_000)

  test("a failed status context is refused instead of merged", async () => {
    await refusedMerge({ checks: [{ __typename: "CheckRun", workflowName: "ci", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:00:00Z" }, { __typename: "StatusContext", context: "ci/deploy", state: "FAILURE" }] }, "the check ci/deploy is red")
  }, 60_000)

  test("a check still running is refused instead of read as green", async () => {
    await refusedMerge({ checks: [{ __typename: "CheckRun", workflowName: "ci", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:00:00Z" }, { __typename: "CheckRun", workflowName: "ci", name: "test", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-02T10:00:00Z" }] }, "the check ci/test has not reported")
  }, 60_000)

  test("a PR with no check reported is refused instead of read as green", async () => {
    await refusedMerge({ checks: [] }, "no check has reported on it")
  }, 60_000)

  test("a PR changed by someone else after the approval is refused", async () => {
    await refusedMerge({ behind: 2, update: "head moved" }, "changed after its checks were read: update-branch found its head is no longer " + head)
  }, 60_000)
})

describe("orc merge lands a green PR", () => {
  test("squash-merges the open green PR at its checked head instead of leaving it open", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim()).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + head])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain("api --hostname github.com repos/acme/orc/compare/main..." + head + "?per_page=1")
      expect(await taskFile(fixture)).toContain(prUrl)
      expect(await taskFile(fixture)).not.toContain("merged_at")
      const board = await runOrc(fixture, ["backlog"])
      expect(board.stdout).toContain("orc-1 orc done")
      expect(board.stdout).not.toContain("done merged")
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ tasks: [{ id: "orc-1", status: "closed", pr: prUrl }] })
      expect(JSON.stringify(json)).not.toContain("mergedAt")
    })
  }, 60_000)

  test("a cancelled check re-run green reads green instead of red", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { checks: [{ __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/31/job/1", name: "test", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-11-02T10:00:00Z" }, { __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/31/job/2", name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:05:00Z" }] })
      expect((await runOrc(fixture, ["merge", "orc-1"])).stdout.trim()).toBe("merged orc-1 " + prUrl)
    })
  }, 60_000)

  test("a task with no PR is refused instead of calling gh", async () => {
    await withMergeFixture(async (fixture) => {
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
      await closeTask(fixture, "orc-1", ranClosing("failed", "no change", null))
      await stubGh(fixture, {})
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toContain("orc-1 names no PR to merge")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)
})
