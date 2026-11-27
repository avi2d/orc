import { describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runOrc, sessionFor } from "./chat-helpers"
import { closedWithPr, foreignHead, forgeSteps, ghCalls, head, mergeCalls, newHead, passed, prUrl, red, type Rollup, running, stubGh, stubRunner, taskFile, updateCall, viewJson, withMergeFixture, writeProject } from "./merge-helpers"

describe("chat merge returns without waiting for CI", () => {
  for (const basis of ["captain-word", "yolo-green"] as const) {
    test(basis + " returns after requesting an update instead of polling CI or merging in the same call", async () => {
      await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1 })
      const requested = await runOrc(fixture, ["merge", "orc-1", "--basis", "captain-word", "--no-wait"])
      expect(requested.stdout).toContain("Run orc merge orc-1 --basis captain-word --no-wait again")
    })
  }, 60_000)

  test("a status context green before the update and not posted on the new head is refused instead of read as green", async () => {
    await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
