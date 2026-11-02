import { describe, expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { closeTask, type Fixture, orchestratorConfig, ranClosing, runOrc, sessionFor, withFixture } from "./chat-helpers"

const prUrl = "https://github.com/acme/orc/pull/8"
const head = "0123456789abcdef0123456789abcdef01234567"

interface Rollup {
  readonly __typename: "CheckRun" | "StatusContext"
  readonly [field: string]: string
}

const passed = (name: string, startedAt = "2026-11-02T10:00:00Z"): Rollup => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", startedAt })

interface Forge {
  readonly state?: "OPEN" | "CLOSED" | "MERGED"
  readonly checks?: ReadonlyArray<Rollup>
  readonly behind?: number
}

const ghCalls = (fixture: Fixture): string => join(fixture.dir, "gh-calls")

const stubGh = async (fixture: Fixture, forge: Forge): Promise<void> => {
  const view = JSON.stringify({ state: forge.state ?? "OPEN", headRefOid: head, baseRefName: "main", statusCheckRollup: forge.checks ?? [passed("lint"), passed("test")] })
  await writeFile(ghCalls(fixture), "")
  await writeFile(join(fixture.dir, "bin", "gh"), [
    "#!/bin/sh",
    "echo \"$*\" >> '" + ghCalls(fixture) + "'",
    "if [ \"$1 $2\" = \"pr view\" ]; then cat <<'J'",
    view,
    "J",
    "exit 0; fi",
    "if [ \"$1\" = api ]; then echo " + String(forge.behind ?? 0) + "; exit 0; fi",
    "if [ \"$1 $2\" = \"pr merge\" ]; then exit 0; fi",
    "echo 'unexpected gh call' >&2",
    "exit 1",
    ""
  ].join("\n"))
  await chmod(join(fixture.dir, "bin", "gh"), 0o755)
}

const writeProject = (fixture: Fixture, extra: Record<string, unknown>): Promise<void> =>
  writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: fixture.dir }, ...extra }] }))

const closedWithPr = async (fixture: Fixture): Promise<void> => {
  expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added task-1 for orc")
  await closeTask(fixture, "task-1", ranClosing("done", "", prUrl))
}

const taskFile = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "closed", "task-1.md"), "utf8")

const mergeCalls = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").filter((line) => line.startsWith("pr merge"))

const refusedMerge = async (forge: Forge, expected: string): Promise<void> => {
  await withFixture(orchestratorConfig, 0, async (fixture) => {
    await closedWithPr(fixture)
    await stubGh(fixture, forge)
    const merged = await runOrc(fixture, ["merge", "task-1"])
    expect(merged.exitCode).not.toBe(0)
    expect(merged.stderr).toContain("orc merge refused task-1 and merged nothing: " + prUrl)
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

  test("a PR behind its base is refused and told to update the branch instead of merged stale", async () => {
    await refusedMerge({ behind: 2 }, "is 2 commits behind main, so update the branch and let its checks run again")
  }, 60_000)
})

describe("orc merge lands a green PR", () => {
  test("squash-merges the open green PR at its checked head instead of leaving it open", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      const merged = await runOrc(fixture, ["merge", "task-1"])
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim()).toBe("merged task-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + head])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain("api --hostname github.com repos/acme/orc/compare/main..." + head + " --jq .behind_by")
      expect(await taskFile(fixture)).toContain(prUrl)
      expect(await taskFile(fixture)).not.toContain("merged_at")
      const board = await runOrc(fixture, ["backlog"])
      expect(board.stdout).toContain("task-1 orc done")
      expect(board.stdout).not.toContain("done merged")
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ tasks: [{ id: "task-1", status: "closed", pr: prUrl }] })
      expect(JSON.stringify(json)).not.toContain("mergedAt")
    })
  }, 60_000)

  test("a cancelled check re-run green reads green instead of red", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, { checks: [{ __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/31/job/1", name: "test", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-11-02T10:00:00Z" }, { __typename: "CheckRun", workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/31/job/2", name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-02T10:05:00Z" }] })
      expect((await runOrc(fixture, ["merge", "task-1"])).stdout.trim()).toBe("merged task-1 " + prUrl)
    })
  }, 60_000)

  test("a task with no PR is refused instead of calling gh", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added task-1 for orc")
      await closeTask(fixture, "task-1", ranClosing("failed", "no change", null))
      await stubGh(fixture, {})
      const merged = await runOrc(fixture, ["merge", "task-1"])
      expect(merged.stderr).toContain("task-1 names no PR to merge")
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
      const refused = await rejection(sessionFor(fixture).call("merge_task", { id: "task-1", basis: "yolo-green" }))
      expect(refused).toBe("orc: orc merge refused task-1 on yolo-green and merged nothing: the project orc has no yolo true, so its PRs merge only on the captain's word")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("yolo-green on a project with no yolo entry is refused instead of read as yolo", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await rejection(sessionFor(fixture).call("merge_task", { id: "task-1", basis: "yolo-green" }))).toContain("the project orc has no yolo true")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("yolo-green on a yolo project's green PR merges it instead of waiting for the captain", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await sessionFor(fixture).call("merge_task", { id: "task-1", basis: "yolo-green" })).toBe("merged task-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + head])
    })
  }, 60_000)

  test("captain-word on a project without yolo merges the green PR instead of refusing it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      expect(await sessionFor(fixture).call("merge_task", { id: "task-1", basis: "captain-word" })).toBe("merged task-1 " + prUrl)
    })
  }, 60_000)

  test("a yolo project's red PR is still refused on yolo-green instead of merged", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: true })
      await closedWithPr(fixture)
      await stubGh(fixture, { checks: [{ __typename: "CheckRun", workflowName: "ci", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:00:00Z" }] })
      expect(await rejection(sessionFor(fixture).call("merge_task", { id: "task-1", basis: "yolo-green" }))).toContain("the check ci/test is red")
      expect(await mergeCalls(fixture)).toEqual([])
    })
  }, 60_000)
})

describe("yolo in projects.json", () => {
  test("a non-boolean yolo is refused naming the project instead of read as true", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: "yes" })
      expect(await rejection(sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" }))).toContain("the project orc names yolo \"yes\", which is not true or false")
      expect(await readFile(join(fixture.home, "backlog", "new", "task-1.md"), "utf8").catch(() => "no task file")).toBe("no task file")
    })
  }, 60_000)

  test("an entry with no yolo reads as before instead of gaining a yolo field", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ projects: [{ name: "orc", checkouts: { mac: fixture.dir } }] })
      expect(JSON.stringify(json)).not.toContain("yolo")
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added task-1 for orc")
    })
  }, 60_000)
})
