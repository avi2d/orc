import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { closeTask, type Fixture, orchestratorConfig, ranClosing, runOrc, sessionFor, withFixture } from "./chat-helpers"
import { closedWithPr, type Forge, ghCalls, head, newHead, passed, prUrl, type Rollup, stubGh, viewJson, writeProject } from "./merge-helpers"

const stubRunner = async (fixture: Fixture): Promise<void> => {
  const runner = join(fixture.dir, "bin", "runner-stub")
  const document = JSON.stringify({ schema: "orc.runner.v1", result: { task: "orc-1", status: "unknown", run: { id: "origin-run", status: "succeeded", prLink: prUrl, endReason: null, openQuestions: [] } } })
  await writeFile(runner, "#!/bin/sh\ncat > /dev/null\necho '" + document + "'\n")
  await chmod(runner, 0o755)
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "mac", slots: 1, start: ["true", "runner", "start", "--", runner] }],
    quota: { provider: "acme", command: ["true"], accounts: [{ name: "main", tokenFile: "/x" }], floorPercent: 15 }
  }))
}

const taskFile = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")

const mergeCalls = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").filter((line) => line.startsWith("pr merge"))

const refusedMerge = async (forge: Forge, expected: string): Promise<void> => {
  await withFixture(orchestratorConfig, 0, async (fixture) => {
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

const foreignHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const red = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:05:00Z" })
const running = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-02T10:05:00Z" })

const updateCall = "api --hostname github.com -X PUT repos/acme/orc/pulls/8/update-branch -f expected_head_sha=" + head

const forgeSteps = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").flatMap((line) =>
    line.startsWith("pr view") ? ["view"] : line.includes("update-branch") ? ["update"] : line.startsWith("pr merge") ? [line] : [])

const sentBackTask = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")

describe("orc merge compares the two sides of a PR behind its base", () => {
  test("records the approved head and checks-running stage instead of leaving the closed task unchanged", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
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
    await withFixture(orchestratorConfig, 0, async (fixture) => {
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
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "base-only.txt" }], mergeRefusal: "At least one approving review is required." })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stderr).toContain("At least one approving review is required.")
      expect(await forgeSteps(fixture)).toEqual(["view", "pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("merges at the checked head instead of updating when the changed paths are disjoint", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 3, baseFiles: [{ filename: "base-only.txt" }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim()).toBe("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("does not treat a capped comparison as proof the changed paths are disjoint", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: Array.from({ length: 300 }, (_, index) => ({ filename: "base-" + index })) })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain(updateCall)
    })
  }, 60_000)

  test("updates a PR when the base renamed a path the PR changed instead of missing the overlap", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "renamed.txt", previous_filename: "shared.txt" }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain(updateCall)
    })
  }, 60_000)

  test("an approved PR with a shared changed path is updated instead of merged at its old head", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
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
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, afterUpdate: [{ head, checks: [passed("lint"), passed("test")] }, { head: newHead, checks: [passed("lint"), running("test")] }, { head: newHead, checks: [passed("lint"), passed("test")] }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "update", "view", "view", "view", "pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR is not merged after the update conflicts, and the task goes back for a fix", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubRunner(fixture)
      await stubGh(fixture, { behind: 2, update: "conflicts" })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.exitCode).not.toBe(0)
      expect(merged.stdout.trim()).toBe("Updating from main")
      expect(merged.stderr).toContain("orc merge refused orc-1 and merged nothing: " + prUrl + " has a merge conflict with main")
      expect(merged.stderr).toContain("sent orc-1 back, so the next beat resumes run origin-run")
      expect(await mergeCalls(fixture)).toEqual([])
      expect(await sentBackTask(fixture)).toContain("update-branch reported a merge conflict between " + head + " and main")
    })
  }, 60_000)

  test("a PR pushed by someone else after the update is refused instead of merged", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
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
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, afterUpdate: [{ head: newHead, checks: [passed("lint")] }, { head: newHead, checks: [passed("lint"), passed("test")] }] })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "update", "view", "view", "pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR with a transient view failure during the wait is still merged once the view answers", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, flakyViews: 1 })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR with a transient parents failure during the wait is still merged once the parents answer", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, flakyParents: 1 })
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a PR is not merged when a check on the new head is red", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
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

describe("chat merge returns without waiting for CI", () => {
  for (const basis of ["captain-word", "yolo-green"] as const) {
    test(basis + " returns after requesting an update instead of polling CI or merging in the same call", async () => {
      await withFixture(orchestratorConfig, 0, async (fixture) => {
        await writeProject(fixture, { yolo: true })
        await closedWithPr(fixture)
        await stubGh(fixture, {
          behind: 1,
          afterUpdate: [
            { head: newHead, checks: [passed("lint"), running("test")] },
            { head: newHead, checks: [passed("lint"), passed("test")] }
          ]
        })
        const session = sessionFor(fixture)
        const result = await session.call("merge_task", { id: "orc-1", basis })
        expect(result).toContain("requested branch update for orc-1 " + prUrl)
        expect(result).toContain("not merged")
        expect(await forgeSteps(fixture)).toEqual(["view", "update"])
        expect(await readFile(ghCalls(fixture), "utf8")).toContain(updateCall)
        expect(await mergeCalls(fixture)).toEqual([])

        await writeFile(join(fixture.dir, "views", "after-1.json"), viewJson("OPEN", { head: newHead, checks: [passed("lint"), passed("test")] }))
        expect(await session.call("merge_task", { id: "orc-1", basis })).toBe("merged orc-1 " + prUrl)
        expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
      })
    }, 60_000)
  }

  const refusalOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const status = (context: string): Rollup => ({ __typename: "StatusContext", context, state: "SUCCESS" })

  test("the retry command names the basis the caller used instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1 })
      const requested = await runOrc(fixture, ["merge", "orc-1", "--basis", "captain-word", "--no-wait"])
      expect(requested.stdout).toContain("Run orc merge orc-1 --basis captain-word --no-wait again")
    })
  }, 60_000)

  test("a status context green before the update and not posted on the new head is refused instead of read as green", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, checks: [passed("lint"), status("ci/deploy")], afterUpdate: [{ head: newHead, checks: [passed("lint")] }] })
      const session = sessionFor(fixture)
      expect(await session.call("merge_task", { id: "orc-1", basis: "captain-word" })).toContain("requested branch update for orc-1")

      const refused = await session.call("merge_task", { id: "orc-1", basis: "captain-word" }).then(String, refusalOf)
      expect(refused).toContain("the check ci/deploy was green before the update and has not reported green on its new head " + newHead)
      expect(await mergeCalls(fixture)).toEqual([])

      await writeFile(join(fixture.dir, "views", "after-last.json"), viewJson("OPEN", { head: newHead, checks: [passed("lint"), status("ci/deploy")] }))
      expect(await session.call("merge_task", { id: "orc-1", basis: "captain-word" })).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a rejected duplicate update does not let the new head merge without a check that passed before the first request", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {
        behind: 1,
        update: "reject duplicate",
        checks: [passed("lint"), status("ci/deploy")],
        afterUpdate: [{ head, checks: [passed("lint")] }, { head: newHead, checks: [passed("lint")] }]
      })
      const session = sessionFor(fixture)
      const merge = () => session.call("merge_task", { id: "orc-1", basis: "captain-word" })
      expect(await merge()).toContain("requested branch update for orc-1")
      expect(await merge().then(String, refusalOf)).toContain("duplicate update request")
      expect(await merge().then(String, refusalOf)).toContain("the check ci/deploy was green before the update and has not reported green")
      expect(await mergeCalls(fixture)).toEqual([])

      await writeFile(join(fixture.dir, "views", "after-last.json"), viewJson("OPEN", { head: newHead, checks: [passed("lint"), status("ci/deploy")] }))
      expect(await merge()).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a red check on the new head sends the task back on the next merge call instead of merging", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubRunner(fixture)
      await stubGh(fixture, { behind: 1, afterUpdate: [{ head: newHead, checks: [passed("lint"), red("test")] }] })
      const session = sessionFor(fixture)
      expect(await session.call("merge_task", { id: "orc-1", basis: "captain-word" })).toContain("requested branch update for orc-1")

      const refused = await session.call("merge_task", { id: "orc-1", basis: "captain-word" }).then(String, refusalOf)
      expect(refused).toContain("the check ci/test is red on its new head " + newHead)
      expect(refused).toContain("sent orc-1 back")
      expect(await mergeCalls(fixture)).toEqual([])
    })
  }, 60_000)

  test("a head that does not descend from the checked head is refused on the next merge call instead of merged", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, parents: foreignHead })
      const session = sessionFor(fixture)
      expect(await session.call("merge_task", { id: "orc-1", basis: "captain-word" })).toContain("requested branch update for orc-1")

      const refused = await session.call("merge_task", { id: "orc-1", basis: "captain-word" }).then(String, refusalOf)
      expect(refused).toContain("changed after its checks were read")
      expect(await mergeCalls(fixture)).toEqual([])
    })
  }, 60_000)

  test("a conflict send-back drops the saved update, so the fixed head is judged on its own checks instead of refused as changed", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubRunner(fixture)
      await stubGh(fixture, { behind: 1, update: "conflicts", parents: foreignHead, afterUpdate: [{ head: newHead, checks: [passed("lint"), passed("test")] }] })
      const closed = await taskFile(fixture)
      const session = sessionFor(fixture)
      const sentBack = await session.call("merge_task", { id: "orc-1", basis: "captain-word" }).then(String, refusalOf)
      expect(sentBack).toContain("has a merge conflict with main")
      expect(sentBack).toContain("sent orc-1 back")

      await rm(join(fixture.home, "backlog", "new", "orc-1.md"))
      await writeFile(join(fixture.home, "backlog", "closed", "orc-1.md"), closed)
      await writeFile(join(fixture.dir, "views", "updated"), "")
      expect(await session.call("merge_task", { id: "orc-1", basis: "captain-word" })).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)

  test("a saved check the new head never runs keeps merge_task refusing, and plain orc merge waits for the new head's own checks instead of staying blocked", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      const unitGreen: Rollup = { ...running("unit"), status: "COMPLETED", conclusion: "SUCCESS" }
      const unitRunning = { head: newHead, checks: [passed("lint"), running("unit")] }
      await stubGh(fixture, { behind: 1, afterUpdate: [unitRunning, unitRunning, unitRunning, { head: newHead, checks: [passed("lint"), unitGreen] }] })
      const session = sessionFor(fixture)
      expect(await session.call("merge_task", { id: "orc-1", basis: "captain-word" })).toContain("requested branch update for orc-1")

      const refused = await session.call("merge_task", { id: "orc-1", basis: "captain-word" }).then(String, refusalOf)
      expect(refused).toContain("the check test was green before the update and has not reported green on its new head " + newHead)
      expect(refused).toContain("or run orc merge orc-1 --basis captain-word to wait for the new head's own checks")
      expect(await mergeCalls(fixture)).toEqual([])

      const merged = await runOrc(fixture, ["merge", "orc-1", "--basis", "captain-word"])
      expect(merged.stdout.trim()).toEndWith("merged orc-1 " + prUrl)
      expect(await forgeSteps(fixture)).toEqual(["view", "update", "view", "view", "view", "view", "pr merge " + prUrl + " --squash --match-head-commit " + newHead])
    })
  }, 60_000)
})

describe("orc merge lands a green PR", () => {
  test("squash-merges the open green PR at its checked head instead of leaving it open", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
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
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { checks: [{ __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/31/job/1", name: "test", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-11-02T10:00:00Z" }, { __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/31/job/2", name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:05:00Z" }] })
      expect((await runOrc(fixture, ["merge", "orc-1"])).stdout.trim()).toBe("merged orc-1 " + prUrl)
    })
  }, 60_000)

  test("a task with no PR is refused instead of calling gh", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
      await closeTask(fixture, "orc-1", ranClosing("failed", "no change", null))
      await stubGh(fixture, {})
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toContain("orc-1 names no PR to merge")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)
})

const rejection = (pending: Promise<string>): Promise<string> =>
  pending.then((text) => "resolved: " + text, (error: unknown) => error instanceof Error ? error.message : String(error))

describe("the merge_task chat tool", () => {
  test("yolo-green on a project without yolo true is refused instead of merged", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: false })
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      const refused = await rejection(sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" }))
      expect(refused).toBe("orc: orc merge refused orc-1 on yolo-green and merged nothing: the project orc has no yolo true, so its PRs merge only on the captain's word")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("yolo-green on a project with no yolo entry is refused instead of read as yolo", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await rejection(sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" }))).toContain("the project orc has no yolo true")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("yolo-green on a yolo project's green PR merges it instead of waiting for the captain", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" })).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("captain-word on a project without yolo merges the green PR instead of refusing it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "captain-word" })).toBe("merged orc-1 " + prUrl)
    })
  }, 60_000)

  test("a yolo project's red PR is still refused on yolo-green instead of merged", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, { checks: [{ __typename: "CheckRun", workflowName: "ci", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:00:00Z" }] })
      expect(await rejection(sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" }))).toContain("the check ci/test is red")
      expect(await mergeCalls(fixture)).toEqual([])
    })
  }, 60_000)
})

describe("owner-word changes cannot change a branch on yolo-green", () => {
  for (const noWait of [false, true]) {
    for (const pendingHead of [null, head, foreignHead]) {
      test("a workflow PR is refused before updating or sending back with noWait=" + String(noWait) + " and pending=" + String(pendingHead), async () => {
        await withFixture(orchestratorConfig, 0, async (fixture) => {
          await writeProject(fixture, { yolo: true })
          await closedWithPr(fixture)
          await stubGh(fixture, {
            behind: 1,
            files: [".github/workflows/ci.yml"],
            checks: pendingHead === foreignHead ? [red("test")] : [passed("test")],
            update: "conflicts"
          })
          const pendingFile = join(fixture.home, "backlog", "logs", "orc-1.merge")
          const pending = JSON.stringify({ url: prUrl, head: pendingHead, green: ["ci/test"] })
          if (pendingHead !== null) {
            await mkdir(join(fixture.home, "backlog", "logs"), { recursive: true })
            await writeFile(pendingFile, pending)
          }
          const result = await runOrc(fixture, ["merge", "orc-1", "--basis", "yolo-green", ...(noWait ? ["--no-wait"] : [])])
          expect(result.exitCode).not.toBe(0)
          expect(result.stdout).toBe("")
          expect(result.stderr).toContain("changes the workflow file .github/workflows/ci.yml, which waits for the captain's merge word")
          if (pendingHead === foreignHead) {
            expect(result.stderr).toContain("the check ci/test is red")
          }
          expect(await forgeSteps(fixture)).toEqual(["view"])
          expect(await taskFile(fixture)).toContain('outcome: "done"')
          expect(await readFile(pendingFile, "utf8").catch(() => null)).toBe(pendingHead === null ? null : pending)
        })
      }, 60_000)
    }
  }

  test("chat reports both the red check and owner-word changes instead of only the first refusal", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, checks: [red("test")], files: ["CHANGELOG.md", ".env.production"] })
      const result = await rejection(sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" }))
      expect(result).toContain("the check ci/test is red")
      expect(result).toContain("is a release, as it changes CHANGELOG.md")
      expect(result).toContain("changes the secret file .env.production")
      expect(await forgeSteps(fixture)).toEqual(["view"])
    })
  }, 60_000)
})

describe("beat merge output", () => {
  test("an overlapping branch update does not corrupt the beat JSON document with progress output", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1 })
      const result = await runOrc(fixture, ["beat", "--json"])
      expect(result.exitCode).toBe(0)
      const document: unknown = JSON.parse(result.stdout)
      expect(document).toMatchObject({
        schema: "orc.beat.v1",
        actions: expect.arrayContaining([
          expect.objectContaining({ kind: "yolo-updating", task: "orc-1", pr: prUrl })
        ])
      })
      expect(await forgeSteps(fixture)).toEqual(["view", "view", "update"])
      expect(await mergeCalls(fixture)).toEqual([])
    })
  }, 60_000)
})

describe("yolo in projects.json", () => {
  test("a non-boolean yolo is refused naming the project instead of read as true", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: "yes" })
      expect(await rejection(sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" }))).toContain("the project orc names yolo \"yes\", which is not true or false")
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8").catch(() => "no task file")).toBe("no task file")
    })
  }, 60_000)

  test("an entry with no yolo reads as before instead of gaining a yolo field", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ projects: [{ name: "orc", checkouts: { mac: fixture.dir } }] })
      expect(JSON.stringify(json)).not.toContain("yolo")
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
    })
  }, 60_000)
})
