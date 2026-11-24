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
const baseHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const mergeBase = "cccccccccccccccccccccccccccccccccccccccc"
const squashHead = "dddddddddddddddddddddddddddddddddddddddd"
const ciRunUrl = "https://github.com/acme/orc/actions/runs/91"

interface ChangedFile {
  readonly filename: string
  readonly previous_filename?: string
}

interface HeadView {
  readonly head: string
  readonly checks: ReadonlyArray<Rollup>
}

interface Forge {
  readonly state?: "OPEN" | "CLOSED" | "MERGED"
  readonly checks?: ReadonlyArray<Rollup>
  readonly behind?: number
  readonly baseFiles?: ReadonlyArray<ChangedFile>
  readonly mainCi?: true
  readonly update?: "updates" | "conflicts" | "head moved"
  readonly afterUpdate?: ReadonlyArray<HeadView>
  readonly parents?: string
  readonly flakyViews?: number
  readonly flakyParents?: number
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
    case "updates":
    case undefined: {
      return ["touch \"$VIEWS/updated\"", "echo '{\"message\":\"Updating pull request branch.\"}'", "exit 0"]
    }
  }
}

const writeMainRuns = (fixture: Fixture, runs: ReadonlyArray<{ readonly sha: string; readonly conclusion: "failure" | "success" | null }>): Promise<void> =>
  writeFile(join(fixture.dir, "views", "main-runs.json"), JSON.stringify([{ workflow_runs: runs.map(({ sha, conclusion }) => ({
    id: 91,
    name: "ci",
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    html_url: ciRunUrl
  })) }]))

const stubGh = async (fixture: Fixture, forge: Forge): Promise<void> => {
  const views = join(fixture.dir, "views")
  const state = forge.state ?? "OPEN"
  const after = forge.afterUpdate ?? [{ head: newHead, checks: [passed("lint"), passed("test")] }]
  await mkdir(views, { recursive: true })
  await writeFile(join(views, "before.json"), viewJson(state, { head, checks: forge.checks ?? [passed("lint"), passed("test")] }))
  await Promise.all(after.map((view, index) => writeFile(join(views, "after-" + String(index + 1) + ".json"), viewJson(state, view))))
  await writeFile(join(views, "after-last.json"), viewJson(state, after.at(-1) ?? { head: newHead, checks: [] }))
  await writeFile(join(views, "pr-comparison.json"), JSON.stringify({
    behind_by: forge.behind ?? 0,
    base_commit: { sha: baseHead },
    merge_base_commit: { sha: mergeBase },
    files: [{ filename: "shared.txt" }]
  }))
  await writeFile(join(views, "base-files.json"), JSON.stringify(forge.baseFiles ?? [{ filename: "shared.txt" }]))
  if (forge.mainCi) {
    await writeFile(join(views, "merged.json"), JSON.stringify({
      state: "MERGED", mergeCommit: { oid: squashHead }, headRefOid: head, baseRefName: "main", statusCheckRollup: []
    }))
    await writeMainRuns(fixture, [])
  }
  await writeFile(ghCalls(fixture), "")
  await writeFile(join(fixture.dir, "bin", "gh"), [
    "#!/bin/sh",
    "VIEWS='" + views + "'",
    "echo \"$*\" >> '" + ghCalls(fixture) + "'",
    "case \"$*\" in *update-branch*)",
    ...updateReply(forge.update),
    ";; esac",
    "if [ \"$1 $2\" = \"pr view\" ]; then",
    "  if [ -f \"$VIEWS/merged\" ]; then cat \"$VIEWS/merged.json\"; exit 0; fi",
    "  if [ ! -f \"$VIEWS/updated\" ]; then cat \"$VIEWS/before.json\"; exit 0; fi",
    "  f=$(( $(cat \"$VIEWS/flaky\" 2>/dev/null || echo 0) + 1 )); echo $f > \"$VIEWS/flaky\"",
    "  if [ \"$f\" -le " + String(forge.flakyViews ?? 0) + " ]; then echo 'gh: Internal Server Error (HTTP 500)' >&2; exit 1; fi",
    "  n=$(( $(cat \"$VIEWS/served\" 2>/dev/null || echo 0) + 1 )); echo $n > \"$VIEWS/served\"",
    "  if [ -f \"$VIEWS/after-$n.json\" ]; then cat \"$VIEWS/after-$n.json\"; else cat \"$VIEWS/after-last.json\"; fi",
    "  exit 0",
    "fi",
    "case \"$*\" in *compare/main..." + head + "*) cat \"$VIEWS/pr-comparison.json\"; exit 0;; esac",
    "case \"$*\" in *compare/" + mergeBase + "..." + baseHead + "*) cat \"$VIEWS/base-files.json\"; exit 0;; esac",
    "case \"$*\" in *commits/*)",
    "  c=$(( $(cat \"$VIEWS/parents-flaky\" 2>/dev/null || echo 0) + 1 )); echo $c > \"$VIEWS/parents-flaky\"",
    "  if [ \"$c\" -le " + String(forge.flakyParents ?? 0) + " ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi",
    "  echo " + (forge.parents ?? head) + "; exit 0;; esac",
    "case \"$*\" in *actions/runs*branch=main*event=push*head_sha=" + squashHead + "*) cat \"$VIEWS/main-runs.json\"; exit $?;; esac",
    "if [ \"$1\" = api ]; then echo 0; exit 0; fi",
    "if [ \"$1 $2\" = \"pr merge\" ]; then",
    "  if [ -f \"$VIEWS/merged.json\" ]; then touch \"$VIEWS/merged\"; fi",
    "  exit 0",
    "fi",
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

const foreignHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const red = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:05:00Z" })
const running = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-02T10:05:00Z" })

const updateCall = "api --hostname github.com -X PUT repos/acme/orc/pulls/8/update-branch -f expected_head_sha=" + head

const forgeSteps = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").flatMap((line) =>
    line.startsWith("pr view") ? ["view"] : line.includes("update-branch") ? ["update"] : line.startsWith("pr merge") ? [line] : [])

const sentBackTask = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")

describe("orc merge compares the two sides of a PR behind its base", () => {
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

describe("CI after merging a behind PR without an update", () => {
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
      expect(alarms()).toEqual(["CI alarm: orc-1 ci failed on main at " + squashHead + " after merging " + prUrl + ". Run: " + ciRunUrl])
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
