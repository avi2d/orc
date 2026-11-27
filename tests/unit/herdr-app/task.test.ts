import { expect, test } from "bun:test"
import { guardJson } from "../../../packages/herdr-app/src/guard"
import { type TaskDetail, answerArgv, descriptionOf, infoRows, mergeArgv, runToOpen, runsOfTask } from "../../../packages/herdr-app/src/task"
import { taskDetails } from "../../../packages/herdr-app/src/task-guard"

const fresh: TaskDetail = {
  id: "orc-34",
  title: "Show the selected task",
  kind: "ship",
  body: "",
  created: "2026-11-13T10:00:00.000Z",
  priority: null,
  parent: null,
  dependsOn: [],
  prState: null,
  hold: null,
  parked: null,
  state: { status: "new" }
}

test("lists the info rows in the fixed order with a dash for each empty one instead of dropping them", () => {
  const rows = infoRows(fresh, [])
  expect(rows.map((row) => row.label)).toEqual(["Parked", "Account", "Run", "Branch", "PR", "Depends on", "Created", "Started", "Closed", "Priority", "Assets"])
  expect(rows.filter((row) => row.label !== "Created").map((row) => row.value)).toEqual(Array.from({ length: 10 }, () => "—"))
})

test("shows a closed task's report file as its asset instead of a dash", () => {
  const closed: TaskDetail = { ...fresh, state: { status: "closed", account: "main", started: null, outcome: "done", pr: null, report: "/home/sam/.orc/reports/orc-34.md", closedAt: "2026-11-13T12:00:00.000Z" } }
  expect(infoRows(closed, []).find((row) => row.label === "Assets")?.value).toBe("/home/sam/.orc/reports/orc-34.md")
})

test("answers a question as id=text and a bare hold as plain words instead of one form for both", () => {
  expect(answerArgv("orc-34", { kind: "question", id: "R2" }, "  drop it ")).toEqual(["backlog", "answer", "orc-34", "R2=drop it"])
  expect(answerArgv("orc-34", { kind: "hold" }, "start it")).toEqual(["backlog", "answer", "orc-34", "start it"])
})

test("puts -- before words that start with a dash instead of sending them as a flag", () => {
  expect(answerArgv("orc-34", { kind: "hold" }, "--help")).toEqual(["backlog", "answer", "orc-34", "--", "--help"])
})

test("sends no answer for a blank box instead of an empty one", () => {
  expect(answerArgv("orc-34", { kind: "hold" }, "   ")).toBeNull()
})

test("merges with the captain's word as basis instead of no basis", () => {
  expect(mergeArgv("orc-34")).toEqual(["merge", "orc-34", "--basis", "captain-word"])
})

test("finds a task's runs by its exact branch instead of a branch it prefixes", () => {
  const runs = [{ id: "r1", branch: "orc/orc-3", machine: null }, { id: "r2", branch: "orc/orc-34", machine: null }]
  expect(runsOfTask(runs, "orc-3").map((run) => run.id)).toEqual(["r1"])
})

test("finds a parent task's planning run on its parent branch instead of showing no runs", () => {
  const runs = [{ id: "r1", branch: "orc/orc-3-parent", machine: null }, { id: "r2", branch: "orc/orc-34-parent", machine: null }]
  expect(runsOfTask(runs, "orc-3").map((run) => run.id)).toEqual(["r1"])
})

test("opens the newest run in the local list instead of a newer run outside it", () => {
  const runs = runsOfTask([{ id: "20261113-100000-a", branch: "orc/orc-34", machine: "mac" }, { id: "20261113-120000-b", branch: "orc/orc-34", machine: null }], "orc-34")
  expect(runToOpen(runs, new Set(["20261113-100000-a"]))).toBe("20261113-100000-a")
})

test("shows no Open run when no run of the task is in the local list instead of opening the newest run anyway", () => {
  const runs = runsOfTask([{ id: "20261113-120000-b", branch: "orc/orc-34", machine: null }], "orc-34")
  expect(runToOpen(runs, new Set([]))).toBeNull()
})

test("drops the title line from the description instead of repeating the header", () => {
  expect(descriptionOf("Show the selected task\n\nThe body stays.")).toBe("The body stays.")
})

test("shows no description for a title-only body instead of repeating the title", () => {
  expect(descriptionOf("Show the selected task\n")).toBe("")
})

test("refuses a backlog task with no body instead of showing an empty description", () => {
  const text = JSON.stringify({ schema: "orc.backlog.v1", tasks: [{ id: "orc-34", title: "t", kind: "ship", created: "2026-11-13T10:00:00.000Z" }] })
  expect(guardJson(text, taskDetails)).toEqual({ kind: "refused", reason: "tasks[0].body is missing" })
})
