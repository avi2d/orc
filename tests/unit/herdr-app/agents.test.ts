import { describe, expect, test } from "bun:test"
import { buildCards, filterCards, stepRows } from "../../../packages/herdr-app/src/agents"
import type { Backlog, Run, Runs, Task } from "../../../packages/herdr-app/src/guard"

const run = (id: string, fields: Partial<Run>): Run => ({
  id, project: "/work/orc", branch: `orc/x-${id}`, status: "running", prLink: null, title: `run ${id}`, step: null, questions: 0, endReason: null, ...fields
})

const task = (id: string, fields: Partial<Task>): Task => ({
  id, title: `task ${id}`, project: "orc", kind: "ship", status: "new", hold: null, parked: null, reason: null, pr: null, ...fields
})

const runs = (list: ReadonlyArray<Run>): Runs => ({ schema: "orc.runs.v1", runs: list })
const backlog = (tasks: ReadonlyArray<Task>, events: ReadonlyArray<string> = []): Backlog => ({ schema: "orc.backlog.v1", tasks, events })

const board = buildCards(
  runs([
    run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" }),
    run("20261113-080000-bbbbbb", { status: "failed", endReason: "orc exited 1" }),
    run("20261113-070000-cccccc", { status: "running", step: { id: 4, name: "fix", attempt: 1, status: "running" } }),
    run("20261113-060000-dddddd", { status: "running", questions: 1, project: "/work/tui-dash" }),
    run("20261113-050000-eeeeee", { status: "succeeded", prLink: "https://github.com/o/r/pull/12" })
  ]),
  backlog([task("orc-48", { status: "closed", pr: "https://github.com/o/r/pull/48" }), task("orc-50", {})])
)

describe("the runs list", () => {
  test("sorts Awaiting you, Running, Queued, Failed, Done instead of newest first", () => {
    expect(board.map((card) => card.standing.status)).toEqual(["Awaiting you", "Awaiting you", "Running", "Queued", "Failed", "Done"])
  })

  test("says where each run is now rather than its raw status", () => {
    expect(board.map((card) => card.where)).toEqual(["Approve PR #48", "Question 1", "Fix 1", "Waiting to start", "orc exited 1", "PR #12"])
  })

  test("a merged PR's run is Done, not still awaiting approval", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" })]),
      backlog([task("orc-48", { status: "closed" })], ["orc-48.merged"])
    )
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([["Done", "Merged PR #48"]])
  })

  test("a task rerun three times shows its newest run once, not one card per run", () => {
    const cards = buildCards(
      runs([
        run("20261113-070000-cccccc", { status: "failed", branch: "orc/orc-7", endReason: "old" }),
        run("20261113-090000-aaaaaa", { status: "running", branch: "orc/orc-7" }),
        run("20261113-080000-bbbbbb", { status: "failed", branch: "orc/orc-7", endReason: "older" })
      ]),
      backlog([task("orc-7", { status: "closed" })])
    )
    expect(cards.map((card) => [card.id, card.runId])).toEqual([["orc-7", "20261113-090000-aaaaaa"]])
  })

  test("the Status filter keeps only Failed runs, not the Done ones beside them", () => {
    expect(filterCards(board, { project: null, status: "Failed" }).map((card) => card.where)).toEqual(["orc exited 1"])
  })

  test("the Project filter keeps one project's runs, not every project's", () => {
    expect(filterCards(board, { project: "tui-dash", status: null }).map((card) => card.where)).toEqual(["Question 1"])
  })

  test("both filters together keep runs that match both, not either", () => {
    expect(filterCards(board, { project: "tui-dash", status: "Running" })).toEqual([])
  })
})

describe("the selected run's steps", () => {
  test("a failed Checks step is marked ✗ and the steps still to come ○, not left out", () => {
    const rows = stepRows({ status: "Running" }, [
      { id: 1, name: "implement", attempt: 1, status: "passed" },
      { id: 2, name: "checks", attempt: 1, status: "failed" }
    ])
    expect(rows.map((row) => `${row.mark} ${row.label}`)).toEqual(["✓ Agent", "✗ Checks 1", "○ Fix 1", "○ Checks 2", "○ PR"])
  })

  test("a running step that waits on an answer is ◆, not ●", () => {
    const rows = stepRows({ status: "Awaiting you", waiting: { on: "answer" } }, [{ id: 1, name: "implement", attempt: 1, status: "running" }])
    expect(rows.map((row) => row.mark)).toEqual(["◆", "○", "○"])
  })

  test("a run not yet started lists every step as not started, not an empty list", () => {
    expect(stepRows({ status: "Queued" }, []).map((row) => `${row.mark} ${row.label}`)).toEqual(["○ Agent", "○ Checks 1", "○ PR"])
  })

  test("a failed run lists no steps to come after the one that failed", () => {
    const rows = stepRows({ status: "Failed" }, [{ id: 1, name: "implement", attempt: 1, status: "failed" }])
    expect(rows.map((row) => `${row.mark} ${row.label}`)).toEqual(["✗ Agent"])
  })
})
