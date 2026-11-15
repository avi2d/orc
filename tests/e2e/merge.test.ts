import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { closeTask, type Fixture, orchestratorConfig, ranClosing, runOrc, sessionFor, withFixture } from "./chat-helpers"

const prUrl = "https://github.com/acme/orc/pull/8"
const head = "0123456789abcdef0123456789abcdef01234567"

interface Rollup {
  readonly __typename: "CheckRun" | "StatusContext"
  readonly [field: string]: string
}

const passed = (name: string, startedAt = "2026-11-02T10:00:00Z"): Rollup => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", startedAt })

const newHead = "fedcba9876543210fedcba9876543210fedcba98"

interface HeadView {
  readonly head: string
  readonly checks: ReadonlyArray<Rollup>
}

interface Forge {
  readonly state?: "OPEN" | "CLOSED" | "MERGED"
  readonly checks?: ReadonlyArray<Rollup>
  readonly behind?: number
  readonly update?: "updates" | "conflicts" | "head moved"
  readonly afterUpdate?: ReadonlyArray<HeadView>
}

const ghCalls = (fixture: Fixture): string => join(fixture.dir, "gh-calls")

const viewJson = (state: string, view: HeadView): string =>
  JSON.stringify({ state, headRefOid: view.head, baseRefName: "main", statusCheckRollup: view.checks })

const updateReply = (update: Forge["update"]): ReadonlyArray<string> => {
  switch (update) {
    case "conflicts": {
      return ["echo '{\"message\":\"merge conflict between base and head\"}'", "echo 'gh: merge conflict between base and head (HTTP 422)' >&2", "exit 1"]
    }
    case "head moved": {
      return ["echo '{\"message\":\"expected head sha did not match current head ref.\"}'", "echo 'gh: expected head sha did not match current head ref. (HTTP 422)' >&2", "exit 1"]
    }
    default: {
      return ["touch \"$VIEWS/updated\"", "echo '{\"message\":\"Updating pull request branch.\"}'", "exit 0"]
    }
  }
}

const stubGh = async (fixture: Fixture, forge: Forge): Promise<void> => {
  const views = join(fixture.dir, "views")
  const state = forge.state ?? "OPEN"
  const after = forge.afterUpdate ?? [{ head: newHead, checks: [passed("lint"), passed("test")] }]
  await mkdir(views, { recursive: true })
  await writeFile(join(views, "before.json"), viewJson(state, { head, checks: forge.checks ?? [passed("lint"), passed("test")] }))
  await Promise.all(after.map((view, index) => writeFile(join(views, "after-" + String(index + 1) + ".json"), viewJson(state, view))))
  await writeFile(join(views, "after-last.json"), viewJson(state, after.at(-1) ?? { head: newHead, checks: [] }))
  await writeFile(ghCalls(fixture), "")
  await writeFile(join(fixture.dir, "bin", "gh"), [
    "#!/bin/sh",
    "VIEWS='" + views + "'",
    "echo \"$*\" >> '" + ghCalls(fixture) + "'",
    "case \"$*\" in *update-branch*)",
    ...updateReply(forge.update),
    ";; esac",
    "if [ \"$1 $2\" = \"pr view\" ]; then",
    "  if [ ! -f \"$VIEWS/updated\" ]; then cat \"$VIEWS/before.json\"; exit 0; fi",
    "  n=$(( $(cat \"$VIEWS/served\" 2>/dev/null || echo 0) + 1 )); echo $n > \"$VIEWS/served\"",
    "  if [ -f \"$VIEWS/after-$n.json\" ]; then cat \"$VIEWS/after-$n.json\"; else cat \"$VIEWS/after-last.json\"; fi",
    "  exit 0",
    "fi",
    "case \"$*\" in *compare/main..." + head + "*) echo " + String(forge.behind ?? 0) + "; exit 0;; esac",
    "if [ \"$1\" = api ]; then echo 0; exit 0; fi",
    "if [ \"$1 $2\" = \"pr merge\" ]; then exit 0; fi",
    "echo 'unexpected gh call' >&2",
    "exit 1",
    ""
  ].join("\n"))
  await chmod(join(fixture.dir, "bin", "gh"), 0o755)
}

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

const writeProject = (fixture: Fixture, extra: Record<string, unknown>): Promise<void> =>
  writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: fixture.dir }, ...extra }] }))

const closedWithPr = async (fixture: Fixture): Promise<void> => {
  expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
  await closeTask(fixture, "orc-1", ranClosing("done", "", prUrl))
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

const red = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:05:00Z" })
const running = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-02T10:05:00Z" })

const updateCall = "api --hostname github.com -X PUT repos/acme/orc/pulls/8/update-branch -f expected_head_sha=" + head

const forgeSteps = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").flatMap((line) =>
    line.startsWith("pr view") ? ["view"] : line.includes("update-branch") ? ["update"] : line.startsWith("pr merge") ? [line] : [])

const sentBackTask = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")

describe("orc merge updates a PR that is only behind its base", () => {
  test("an approved PR behind main is updated instead of refused", async () => {
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

describe("orc merge lands a green PR", () => {
  test("squash-merges the open green PR at its checked head instead of leaving it open", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await closedWithPr(fixture)
      await stubGh(fixture, {})
      const merged = await runOrc(fixture, ["merge", "orc-1"])
      expect(merged.stderr).toBe("")
      expect(merged.stdout.trim()).toBe("merged orc-1 " + prUrl)
      expect(await mergeCalls(fixture)).toEqual(["pr merge " + prUrl + " --squash --match-head-commit " + head])
      expect(await readFile(ghCalls(fixture), "utf8")).toContain("api --hostname github.com repos/acme/orc/compare/main..." + head + " --jq .behind_by")
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
