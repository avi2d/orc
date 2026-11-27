import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runOrc, sessionFor } from "./chat-helpers"
import { closedWithPr, foreignHead, forgeSteps, ghCalls, head, mergeCalls, passed, prUrl, red, stubGh, taskFile, withMergeFixture, writeProject } from "./merge-helpers"

const rejection = (pending: Promise<string>): Promise<string> =>
  pending.then((text) => "resolved: " + text, (error: unknown) => error instanceof Error ? error.message : String(error))

describe("the merge_task chat tool", () => {
  test("yolo-green on a project without yolo true is refused instead of merged", async () => {
    await withMergeFixture(async (fixture) => {
      await writeProject(fixture, { yolo: false })
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      const refused = await rejection(sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" }))
      expect(refused).toBe("orc: orc merge refused orc-1 on yolo-green and merged nothing: the project orc has no yolo true, so its PRs merge only on the captain's word")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("yolo-green on a project with no yolo entry is refused instead of read as yolo", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await rejection(sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" }))).toContain("the project orc has no yolo true")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("yolo-green on a yolo project's green PR merges it instead of waiting for the captain", async () => {
    await withMergeFixture(async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "yolo-green" })).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("captain-word on a project without yolo merges the green PR instead of refusing it", async () => {
    await withMergeFixture(async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await sessionFor(fixture).call("merge_task", { id: "orc-1", basis: "captain-word" })).toBe("merged orc-1 " + prUrl)
    })
  }, 60_000)

  test("a yolo project's red PR is still refused on yolo-green instead of merged", async () => {
    await withMergeFixture(async (fixture) => {
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
        await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
    await withMergeFixture(async (fixture) => {
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
