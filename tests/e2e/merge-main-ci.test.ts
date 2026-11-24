import { describe, expect, test } from "bun:test"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Fixture, orchestratorConfig, runOrc, sessionFor, withFixture } from "./chat-helpers"
import { baseHead, ciRunUrl, closedWithPr, ghCalls, head, mergeBase, newHead, prUrl, squashHead, stubGh, writeMainRuns, writeProject } from "./merge-helpers"

describe("CI after merging a behind PR without an update", () => {
  test("an empty run list 30 minutes after mergedAt removes the watch instead of polling forever", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {
        behind: 1, baseFiles: [{ filename: "base-only.txt" }], mainCi: true,
        mergedAt: new Date(Date.now() - 31 * 60_000).toISOString()
      })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
      for (let poll = 0; poll < 2; poll++) {
        expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
        expect(await readdir(join(fixture.home, "backlog", "main-ci"))).toEqual([])
        const calls = (await readFile(ghCalls(fixture), "utf8")).split("\n")
        expect(calls.filter((call) => call.includes("/actions/runs?"))).toHaveLength(1)
      }
      const chat = sessionFor(fixture)
      await chat.postClosed()
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([])
    })
  }, 60_000)

  test("keeps an empty recent watch instead of giving up before 30 minutes", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "base-only.txt" }], mainCi: true })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      expect(await readdir(join(fixture.home, "backlog", "main-ci"))).toHaveLength(1)
    })
  }, 60_000)

  test("keeps a running workflow after 30 minutes instead of expiring an active watch", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {
        behind: 1, baseFiles: [{ filename: "base-only.txt" }], mainCi: true,
        mergedAt: new Date(Date.now() - 31 * 60_000).toISOString()
      })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
      await writeMainRuns(fixture, [{ sha: squashHead, conclusion: null }])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      expect(await readdir(join(fixture.home, "backlog", "main-ci"))).toHaveLength(1)
    })
  }, 60_000)

  test("alerts the owner once for a failed run at the squash commit, not an earlier red run", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "base-only.txt" }], mainCi: true })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
      const chat = sessionFor(fixture)
      const alarms = () => chat.posted.filter((post) => post.startsWith("CI alarm:"))
      const beat = async () => {
        expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
        await chat.postClosed()
      }
      await writeMainRuns(fixture, [{ sha: baseHead, conclusion: "failure" }])
      await beat()
      expect(alarms()).toEqual([])
      await writeMainRuns(fixture, [{ sha: squashHead, conclusion: null }])
      await beat()
      expect(alarms()).toEqual([])
      await writeMainRuns(fixture, [{ sha: squashHead, conclusion: "failure" }])
      await beat()
      await beat()
      expect(alarms()).toEqual(["CI alarm: ci failed on main at " + squashHead + " after merging " + prUrl + ". Run: " + ciRunUrl])
    })
  }, 60_000)

  test("a green squash commit settles the watch without an alarm or repeated polling", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "base-only.txt" }], mainCi: true })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
      await writeMainRuns(fixture, [{ sha: squashHead, conclusion: "success" }])
      for (let poll = 0; poll < 2; poll++) {
        const beat = await runOrc(fixture, ["beat"])
        expect(beat.exitCode).toBe(0)
        const calls = await readFile(ghCalls(fixture), "utf8")
        expect(calls.split("\n").filter((call) => call.includes("/actions/runs?"))).toHaveLength(1)
      }
      const chat = sessionFor(fixture)
      await chat.postClosed()
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([])
    })
  }, 60_000)
})

const watchProject = async (fixture: Fixture, origin = "https://github.com/acme/orc.git"): Promise<void> => {
  for (const args of [["init", "--quiet"], ["remote", "add", "origin", origin]]) {
    const child = Bun.spawn(["git", "-C", fixture.dir, ...args], { stdout: "ignore", stderr: "pipe" })
    const stderr = await new Response(child.stderr).text()
    expect({ exitCode: await child.exited, stderr }).toEqual({ exitCode: 0, stderr: "" })
  }
}

interface BaseRun {
  readonly sha: string
  readonly id?: number
  readonly branch?: string
  readonly event?: string
  readonly updatedAt?: string
  readonly conclusion: "failure" | "timed_out" | "success" | null
}

const baseRepository = (runs: ReadonlyArray<BaseRun>) => ({
  defaultBranchRef: {
    name: "main",
    target: { history: { nodes: runs.map((run) => ({
      oid: run.sha,
      checkSuites: { nodes: [{
        branch: { name: run.branch ?? "main" },
        status: run.conclusion === null ? "IN_PROGRESS" : "COMPLETED",
        conclusion: run.conclusion?.toUpperCase() ?? null,
        updatedAt: run.updatedAt ?? new Date().toISOString(),
        workflowRun: {
          event: run.event ?? "push",
          url: "https://github.com/acme/orc/actions/runs/" + String(run.id ?? 91),
          workflow: { name: "ci" }
        }
      }] }
    })) } }
  }
})

const writeBaseRuns = (fixture: Fixture, runs: ReadonlyArray<BaseRun>): Promise<void> =>
  writeFile(join(fixture.dir, "views", "base-runs.json"), JSON.stringify({ data: { r0: baseRepository(runs) } }))

describe("main CI alarms independent of the merge path", () => {
  test("a red run at the current base head does not alarm on the first beat", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await watchProject(fixture)
      await stubGh(fixture, {})
      await writeBaseRuns(fixture, [{ sha: head, conclusion: "failure", updatedAt: "2026-01-01T00:00:00Z" }])
      const chat = sessionFor(fixture)
      const alarms = () => chat.posted.filter((post) => post.startsWith("CI alarm:"))
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      await chat.postClosed()
      expect(alarms()).toEqual([])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      await chat.postClosed()
      expect(alarms()).toEqual(["CI alarm: ci failed on main at " + head + ". Run: " + ciRunUrl])
    })
  }, 60_000)

  test("a red run already superseded when Orc first sees the repository raises no alarm instead of a burst", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await watchProject(fixture)
      await stubGh(fixture, {})
      const chat = sessionFor(fixture)
      const alarms = () => chat.posted.filter((post) => post.startsWith("CI alarm:"))
      const beat = async () => {
        expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
        await chat.postClosed()
      }
      await writeBaseRuns(fixture, [
        { sha: newHead, id: 92, conclusion: "success", updatedAt: "2026-11-01T10:00:00Z" },
        { sha: squashHead, id: 93, conclusion: "failure", updatedAt: "2026-11-01T09:00:00Z" },
        { sha: baseHead, id: 94, conclusion: "timed_out", updatedAt: "2026-11-01T08:00:00Z" }
      ])
      await beat()
      await beat()
      expect(alarms()).toEqual([])
      await writeBaseRuns(fixture, [{ sha: head, conclusion: "failure" }, { sha: newHead, id: 92, conclusion: "success", updatedAt: "2026-11-01T10:00:00Z" }])
      await beat()
      expect(alarms()).toEqual(["CI alarm: ci failed on main at " + head + ". Run: " + ciRunUrl])
    })
  }, 60_000)

  test("a red run finished after Orc first saw the repository alarms even when a newer head exists", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await watchProject(fixture)
      await stubGh(fixture, {})
      await writeBaseRuns(fixture, [{ sha: newHead, id: 92, conclusion: "success", updatedAt: "2026-11-01T10:00:00Z" }])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      await writeBaseRuns(fixture, [
        { sha: head, id: 95, conclusion: "success" },
        { sha: squashHead, conclusion: "failure" }
      ])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      const chat = sessionFor(fixture)
      await chat.postClosed()
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual(["CI alarm: ci failed on main at " + squashHead + ". Run: " + ciRunUrl])
    })
  }, 60_000)

  test("one repository the token cannot resolve does not silence the alarms of the others on its host", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await watchProject(fixture, "https://github.com/acme/other.git")
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      await writeFile(join(fixture.dir, "views", "base-fails"), "")
      await writeFile(join(fixture.dir, "views", "base-runs.json"), JSON.stringify({
        data: { r0: null, r1: baseRepository([{ sha: squashHead, conclusion: "failure" }]) },
        errors: [{ type: "NOT_FOUND", path: ["r0"], message: "Could not resolve to a Repository with the name 'acme/orc'." }]
      }))
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      const chat = sessionFor(fixture)
      await chat.postClosed()
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual(["CI alarm: ci failed on main at " + squashHead + ". Run: " + ciRunUrl])
    })
  }, 60_000)

  test("keeps alarming after a remote project's PR is cached as merged instead of requiring a local checkout", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await writeProject(fixture, { checkouts: { mac: join(fixture.dir, "missing-checkout") } })
      await stubGh(fixture, { state: "MERGED" })
      await writeBaseRuns(fixture, [])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      await writeBaseRuns(fixture, [{ sha: squashHead, conclusion: "failure" }])
      const chat = sessionFor(fixture)
      for (let poll = 0; poll < 2; poll++) {
        expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
        await chat.postClosed()
      }
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([
        "CI alarm: ci failed on main at " + squashHead + ". Run: " + ciRunUrl
      ])
    })
  }, 60_000)

  for (const path of ["outside Orc", "already current", "updated"] as const) {
    test("alarms once for a red main run after a PR merged " + path + " instead of requiring a disjoint merge", async () => {
      await withFixture(orchestratorConfig, 0, async (fixture) => {
        await watchProject(fixture)
        await stubGh(fixture, { behind: path === "updated" ? 1 : 0, mainCi: true })
        if (path !== "outside Orc") {
          await closedWithPr(fixture)
          expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
        }
        await writeBaseRuns(fixture, [{ sha: squashHead, conclusion: "failure" }])
        const chat = sessionFor(fixture)
        for (let poll = 0; poll < 2; poll++) {
          expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
          await chat.postClosed()
        }
        expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([
          "CI alarm: ci failed on main at " + squashHead + ". Run: " + ciRunUrl
        ])
        const calls = (await readFile(ghCalls(fixture), "utf8")).split("\n")
        expect(calls.filter((call) => call.includes(" graphql "))).toHaveLength(2)
      })
    }, 60_000)
  }

  test("does not double-alarm when both the squash watch and base watch see the same red run", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await watchProject(fixture)
      await closedWithPr(fixture)
      await stubGh(fixture, { behind: 1, baseFiles: [{ filename: "base-only.txt" }], mainCi: true })
      expect((await runOrc(fixture, ["merge", "orc-1"])).exitCode).toBe(0)
      await writeMainRuns(fixture, [{ sha: squashHead, conclusion: "failure" }])
      await writeBaseRuns(fixture, [{ sha: squashHead, conclusion: "failure" }])
      const chat = sessionFor(fixture)
      for (let poll = 0; poll < 2; poll++) {
        expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
        await chat.postClosed()
      }
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([
        "CI alarm: ci failed on main at " + squashHead + " after merging " + prUrl + ". Run: " + ciRunUrl
      ])
    })
  }, 60_000)

  test("ignores other branches, non-push runs, green and running checks instead of raising false alarms", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await watchProject(fixture)
      await stubGh(fixture, {})
      await writeBaseRuns(fixture, [
        { sha: head, id: 92, branch: "topic", conclusion: "failure" },
        { sha: baseHead, id: 93, event: "pull_request", conclusion: "failure" },
        { sha: newHead, id: 94, conclusion: "success" },
        { sha: mergeBase, id: 95, conclusion: null }
      ])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      const chat = sessionFor(fixture)
      await chat.postClosed()
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([])
      await writeBaseRuns(fixture, [{ sha: squashHead, conclusion: "timed_out" }])
      expect((await runOrc(fixture, ["beat"])).exitCode).toBe(0)
      await chat.postClosed()
      expect(chat.posted.filter((post) => post.startsWith("CI alarm:"))).toEqual([
        "CI alarm: ci failed on main at " + squashHead + ". Run: " + ciRunUrl
      ])
    })
  }, 60_000)
})
