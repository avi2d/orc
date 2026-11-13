import { describe, expect, test } from "bun:test"
import { buildCards, filterCards, stepRows } from "../../../packages/herdr-app/src/agents"
import type { Backlog, Run, Runs, Task } from "../../../packages/herdr-app/src/guard"

const run = (id: string, fields: Partial<Run>): Run => ({
  id, project: "/work/orc", branch: `orc/x-${id}`, status: "running", prLink: null, title: `run ${id}`, step: null, questions: 0, endReason: null, kind: null, delivery: null, ...fields
})

const task = (id: string, fields: Partial<Task>): Task => ({
  id, title: `task ${id}`, project: "orc", kind: "ship", status: "new", hold: null, parked: null, reason: null, ...fields
})

const runs = (list: ReadonlyArray<Run>): Runs => ({ schema: "orc.runs.v1", runs: list })
const backlog = (tasks: ReadonlyArray<Task>, merged: ReadonlyArray<string> = []): Backlog => ({ schema: "orc.backlog.v1", tasks, merged })

const board = buildCards(
  runs([
    run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" }),
    run("20261113-080000-bbbbbb", { status: "failed", endReason: "orc exited 1" }),
    run("20261113-070000-cccccc", { status: "running", step: { id: 4, name: "fix", attempt: 1, status: "running" } }),
    run("20261113-060000-dddddd", { status: "running", questions: 1, project: "/work/tui-dash" }),
    run("20261113-050000-eeeeee", { status: "succeeded", prLink: "https://github.com/o/r/pull/12" })
  ]),
  backlog([task("orc-48", { status: "closed" }), task("orc-50", {})])
)

describe("the runs list", () => {
  test("sorts Awaiting you, Running, Queued, Failed, Done instead of newest first", () => {
    expect(board.map((card) => card.standing.status)).toEqual(["Awaiting you", "Awaiting you", "Running", "Queued", "Failed", "Done"])
  })

  test("says where each run is now rather than its raw status", () => {
    expect(board.map((card) => card.where)).toEqual(["Approve PR #48", "Question 1", "Fix 1", "Waiting to start", "orc exited 1", "PR #12"])
  })

  test("a run started outside the backlog carries no kind rather than a made-up one", () => {
    const cards = buildCards(runs([run("20261113-090000-aaaaaa", { status: "failed", branch: "orc/20261113-090000-aaaaaa" })]), backlog([]))
    expect(cards.map((card) => [card.id, card.kind])).toEqual([["20261113-090000-aaaaaa", null]])
  })

  test("a backlog task's run carries the task's kind, not the run's", () => {
    const cards = buildCards(runs([run("20261113-090000-aaaaaa", { branch: "orc/orc-7" })]), backlog([task("orc-7", { kind: "scout", status: "claimed" })]))
    expect(cards.map((card) => [card.id, card.kind])).toEqual([["orc-7", "scout"]])
  })

  test("a failed run with an open follow up task stays Failed with its run id, not Queued", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "failed", branch: "orc/orc-7", endReason: "old", questions: 0 })]),
      backlog([task("orc-7", { status: "new" })])
    )
    expect(cards.map((card) => [card.id, card.runId, card.standing.status])).toEqual([["orc-7", "20261113-090000-aaaaaa", "Failed"]])
  })

  test("a merged PR's run is Done, not still awaiting approval", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" })]),
      backlog([task("orc-48", { status: "closed" })], ["orc-48"])
    )
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([["Done", "Merged PR #48"]])
  })

  test("a task rerun three times shows every run, not only its newest run", () => {
    const cards = buildCards(
      runs([
        run("20261113-070000-cccccc", { status: "failed", branch: "orc/orc-7", endReason: "old" }),
        run("20261113-090000-aaaaaa", { status: "running", branch: "orc/orc-7" }),
        run("20261113-080000-bbbbbb", { status: "failed", branch: "orc/orc-7", endReason: "older" })
      ]),
      backlog([task("orc-7", { status: "closed" })])
    )
    expect(cards.map((card) => [card.id, card.runId])).toEqual([["orc-7", "20261113-090000-aaaaaa"], ["orc-7", "20261113-070000-cccccc"], ["orc-7", "20261113-080000-bbbbbb"]])
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
    ], "ship", null)
    expect(rows.map((row) => `${row.mark} ${row.label}`)).toEqual(["✓ Agent", "✗ Checks 1", "○ Fix 1", "○ Checks 2", "○ No mistakes"])
  })

  test("a running step that waits on an answer is ◆, not ●", () => {
    const rows = stepRows({ status: "Awaiting you", waiting: { on: "answer" } }, [{ id: 1, name: "implement", attempt: 1, status: "running" }], "ship", null)
    expect(rows.map((row) => row.mark)).toEqual(["◆", "○", "○"])
  })

  test("a run not yet started lists every step as not started, not an empty list", () => {
    expect(stepRows({ status: "Queued" }, [], "ship", null).map((row) => `${row.mark} ${row.label}`)).toEqual(["○ Agent", "○ Checks 1", "○ No mistakes"])
  })

  test("a failed run lists no steps to come after the one that failed", () => {
    const rows = stepRows({ status: "Failed" }, [{ id: 1, name: "implement", attempt: 1, status: "failed" }])
    expect(rows.map((row) => `${row.mark} ${row.label}`)).toEqual(["✗ Agent"])
  })

  test("a stopped run marks its running step ✗, not ●", () => {
    const rows = stepRows({ status: "Failed" }, [{ id: 1, name: "implement", attempt: 1, status: "running" }], "ship", null)
    expect(rows.map((row) => `${row.mark} ${row.label}`)).toEqual(["✗ Agent"])
  })

  test("a scout run shows only its Agent step, not Checks and PR", () => {
    expect(stepRows({ status: "Queued" }, [], "scout", null).map((row) => row.label)).toEqual(["Agent"])
  })

  test("duplicate checks attempts still predict the next round as max plus one, not count plus one", () => {
    const rows = stepRows({ status: "Running" }, [
      { id: 1, name: "implement", attempt: 1, status: "passed" },
      { id: 2, name: "checks", attempt: 1, status: "passed" },
      { id: 3, name: "fix", attempt: 1, status: "passed" },
      { id: 4, name: "checks", attempt: 1, status: "failed" },
      { id: 5, name: "fix", attempt: 2, status: "running" }
    ], "ship", null)
    expect(rows.map((row) => `${row.mark} ${row.label}`)).toEqual(["\u2713 Agent", "\u2713 Checks 1", "\u2713 Fix 1", "\u2717 Checks 1", "\u25cf Fix 2", "\u25cb Checks 2", "\u25cb No mistakes"])
  })
})
