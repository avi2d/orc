import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { closeTask, ranClosing, runOrc, sessionFor } from "./chat-helpers"
import { closedWithPr, foreignHead, forgeSteps, ghCalls, head, mergeCalls, newHead, passed, prUrl, red, running, sentBackTask, stubGh, stubRunner, taskFile, updateCall, withMergeFixture } from "./merge-helpers"

describe("orc merge compares the two sides of a PR behind its base", () => {
  test("records the approved head and checks-running stage instead of leaving the closed task unchanged", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1 })
      const result = await runOrc(fixture, ["merge", "orc-1", "--basis", "captain-word", "--no-wait"])
      expect(result.exitCode).toBe(0)
      const text = await taskFile(fixture)
      const front: unknown = Bun.YAML.parse(text.split("---\n")[1])
      expect(front).toMatchObject({ merge: { basis: "captain-word", head, green: ["lint", "test"], stage: "checks-running" } })
    })
  }, 60_000)
  test("updates a disjoint PR rejected as out of date instead of refusing every retry", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {
        behind: 3,
        baseFiles: [{ filename: "base-only.txt" }],
        mergeRefusal: "Pull request is not mergeable: the head branch is not up to date with the base branch."
      })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).toBe(0)
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim().split("\n")).toEqual(["Updating from main", "Checks running", "merged orc-1 " + prUrl])
      expect(await forgeSteps(fixture)).toEqual([
        "view", "pr merge " + prUrl + " --squash --match-head-commit " + head,
        "update", "view", "pr merge " + prUrl + " --squash --match-head-commit " + newHead
      ])
    })
  }, 60_000)

  test("does not update a disjoint PR when the merge is refused for another policy", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "base-only.txt" }], mergeRefusal: "At least one approving review is required." })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stderr).toContain("At least one approving review is required.")
      expect(await forgeSteps(fixture)).toEqual(["view", "pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("merges at the checked head instead of updating when the changed paths are disjoint", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 3, baseFiles: [{ filename: "base-only.txt" }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim()).toBe("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("does not treat a capped comparison as proof the changed paths are disjoint", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: Array.from({ length: 300 }, (_, index) => ({ filename: "base-" + index })) })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain(updateCall)
    })
  }, 60_000)

  test("updates a PR when the base renamed a path the PR changed instead of missing the overlap", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "renamed.txt", previous_filename: "shared.txt" }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain(updateCall)
    })
  }, 60_000)

  test("an approved PR with a shared changed path is updated instead of merged at its old head", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 3 })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim().split("\n")).toEqual(["Updating from main", "Checks running", "merged orc-1 " + prUrl])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain(updateCall)
      expect(await readFile(ghCalls(fixture), "utf8")).toContain("api --hostname github.com repos/acme/orc/compare/main..." + newHead + " --jq .behind_by")
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR is not merged before the new head's checks pass", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, afterUpdate: [{ head, checks: [passed("lint"), passed("test")] }, { head: newHead, checks: [passed("lint"), running("test")] }, { head: newHead, checks: [passed("lint"), passed("test")] }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "update", "view", "view", "view", "pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR is not merged after the update conflicts, and the task goes back for a fix", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubRunner(fixture)
      await stubGh(fixture, { behind: 2, update: "conflicts" })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stdout.trim()).toBe("Updating from main")
      expect(merged.stderr).toContain("orc merge refused orc-1 and merged nothing: " + prUrl + " has a merge conflict with main")
      expect(merged.stderr).toContain("sent orc-1 back, so the next beat resumes run origin-run")
      expect(await mergeCalls(fixture)).toEqual([])
      const sent = await sentBackTask(fixture)
      expect(sent).toContain("update-branch reported a merge conflict between " + head + " and main")
      const front: unknown = Bun.YAML.parse(sent.split("---\n")[1])
      expect(front).toMatchObject({ merge: { basis: "captain-word", head, stage: "conflicted", detail: "main" } })
    })
  }, 60_000)

  test("a captain's send-back after a conflicted re-close drops the conflict instead of labelling the review a merge conflict", async () => {
    await withMergeFixture(async (fixture) => {
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
      await closeTask(fixture, "orc-1", [...ranClosing("done", "", prUrl), "merge: { basis: captain-word, head: " + head + ", green: [lint], stage: conflicted, detail: main }"])
      await stubRunner(fixture)
      await stubGh(fixture, {})
      const sent = await runOrc(fixture, ["backlog", "send-back", "orc-1", "rename", "the", "flag"])
      expect(sent.stderr).toBe("")
      expect(sent.exitCode).toBe(0)
      const text = await sentBackTask(fixture)
      expect(text).toContain("rename the flag")
      const front: unknown = Bun.YAML.parse(text.split("---\n")[1])
      expect(front).not.toHaveProperty("merge")
    })
  }, 60_000)

  test("a later refusal clears the red check an earlier attempt recorded instead of keeping the stale stage", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { checks: [passed("lint"), red("test")] })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).not.toBe(0)
      const first: unknown = Bun.YAML.parse((await taskFile(fixture)).split("---\n")[1])
      expect(first).toMatchObject({ merge: { stage: "check-failed", detail: "ci/test" } })
      await stubGh(fixture, { checks: [passed("lint"), running("test")] })
      const second = await runOrc(fixture, ["merge", "orc-1"])
      expect(second.stderr).toContain("the check ci/test has not reported")
      const front: unknown = Bun.YAML.parse((await taskFile(fixture)).split("---\n")[1])
      expect(front).not.toHaveProperty("merge")
    })
  }, 60_000)

  test("a PR pushed by someone else after the update is refused instead of merged", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 2, parents: foreignHead, afterUpdate: [{ head: newHead, checks: [passed("lint"), passed("test")] }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stderr).toContain("orc merge refused orc-1 and merged nothing: " + prUrl + " changed after its checks were read: update-branch found its head is no longer " + head)
      expect(await mergeCalls(fixture)).toEqual([])
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8").then(() => "sent back", () => "left closed")).toBe("left closed")
    })
  }, 60_000)

  test("a PR waits until every checked check is green on the new head", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, afterUpdate: [{ head: newHead, checks: [passed("lint")] }, { head: newHead, checks: [passed("lint"), passed("test")] }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "update", "view", "view", "pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR with a transient view failure during the wait is still merged once the view answers", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, flakyViews: 1 })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR with a transient parents failure during the wait is still merged once the parents answer", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, flakyParents: 1 })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR is not merged when a check on the new head is red", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubRunner(fixture)
      await stubGh(fixture, { behind: 2, afterUpdate: [{ head: newHead, checks: [passed("lint"), red("test")] }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stderr).toContain("orc merge refused orc-1 and merged nothing: " + prUrl + " the check ci/test is red on its new head " + newHead)
      expect(merged.stderr).toContain("sent orc-1 back")
      expect(await mergeCalls(fixture)).toEqual([])
      expect(await sentBackTask(fixture)).toContain("the check ci/test is red on the new head " + newHead)
    })
  }, 60_000)
})
