import { expect, test } from "bun:test"
import { guardJson } from "../../../packages/herdr-app/src/guard"
import { type TaskDetail, answerArgv, descriptionOf, infoRows, mergeArgv, runToOpen, runsOfTask, threadEntries } from "../../../packages/herdr-app/src/task"
import { taskDetails } from "../../../packages/herdr-app/src/task-guard"

const fresh: TaskDetail = {
  id: "orc-34",
  title: "Show the selected task",
  kind: "ship",
  body: "",
  created: "2026-11-13T10:00:00.000Z",
  priority: null,
  dependsOn: [],
  prState: null,
  hold: null,
  parked: null,
  state: { status: "new" }
}

const asked = (id: string, answered: boolean) => ({
  id, text: `question ${id}`, asked: "2026-11-13T11:00:00.000Z",
  answer: answered ? { words: "yes", at: "2026-11-13T12:00:00.000Z" } : null
})

test("lists the info rows in the fixed order with a dash for each empty one instead of dropping them", () => {
  const rows = infoRows(fresh, [])
  expect(rows.map((row) => row.label)).toEqual(["Account", "Run", "Branch", "PR", "Depends on", "Created", "Started", "Closed", "Priority", "Assets"])
  expect(rows.filter((row) => row.label !== "Created").map((row) => row.value)).toEqual(Array.from({ length: 9 }, () => "—"))
})

test("shows a closed task's report file as its asset instead of a dash", () => {
  const closed: TaskDetail = { ...fresh, state: { status: "closed", account: "main", started: null, outcome: "done", pr: null, report: "/home/sam/.orc/reports/orc-34.md", answer: null, closedAt: "2026-11-13T12:00:00.000Z" } }
  expect(infoRows(closed, []).find((row) => row.label === "Assets")?.value).toBe("/home/sam/.orc/reports/orc-34.md")
})

test("answers a question as id=text and a bare hold as plain words instead of one form for both", () => {
  expect(answerArgv("orc-34", { kind: "question", id: "R2" }, "  drop it ")).toEqual(["backlog", "answer", "orc-34", "R2=drop it"])
  expect(answerArgv("orc-34", { kind: "hold" }, "start it")).toEqual(["backlog", "answer", "orc-34", "start it"])
})

test("sends no answer for a blank box instead of an empty one", () => {
  expect(answerArgv("orc-34", { kind: "hold" }, "   ")).toBeNull()
})

test("merges with the captain's word as basis instead of no basis", () => {
  expect(mergeArgv("orc-34")).toEqual(["merge", "orc-34", "--basis", "captain-word"])
})

test("gives a hold without questions one answer box instead of none", () => {
  const held: TaskDetail = { ...fresh, hold: { reason: "waits for the PR", until: null, at: null, questions: [], answer: null, history: [] } }
  expect(threadEntries(held).map((entry) => entry.reply)).toEqual([{ kind: "hold" }])
})

test("gives a box to each unanswered question only instead of the hold or an answered one", () => {
  const held: TaskDetail = { ...fresh, hold: { reason: "two questions", until: null, at: null, questions: [asked("Q1", true), asked("Q2", false)], answer: null, history: [] } }
  expect(threadEntries(held).filter((entry) => entry.reply !== null).map((entry) => entry.reply)).toEqual([{ kind: "question", id: "Q2" }])
})

test("shows each answered question once instead of again in the hold's joined answer", () => {
  const answered = { words: "question Q1: yes\nquestion Q2: yes", at: "2026-11-13T12:00:00.000Z" }
  const held: TaskDetail = { ...fresh, hold: { reason: "two questions", until: null, at: null, questions: [asked("Q1", true), asked("Q2", true)], answer: answered, history: [] } }
  expect(threadEntries(held).map((entry) => entry.what)).toEqual(["Hold", "Question Q1", "Answer to Q1", "Question Q2", "Answer to Q2"])
})

test("puts each parked answer under its question with who and time instead of leaving it out", () => {
  const parked: TaskDetail = { ...fresh, parked: { branch: "orc/orc-34", questions: [asked("R3", true)] } }
  expect(threadEntries(parked).map((entry) => [entry.who, entry.what, entry.at])).toEqual([
    ["Run", "Question R3", "2026-11-13T11:00:00.000Z"],
    ["Answer", "Answer to R3", "2026-11-13T12:00:00.000Z"]
  ])
})

test("finds a task's runs by its exact branch instead of a branch it prefixes", () => {
  const runs = [{ id: "r1", branch: "orc/orc-3", machine: null }, { id: "r2", branch: "orc/orc-34", machine: null }]
  expect(runsOfTask(runs, "orc-3").map((run) => run.id)).toEqual(["r1"])
})

test("opens the newest run in the local list instead of a newer run outside it", () => {
  const runs = runsOfTask([{ id: "20261113-100000-a", branch: "orc/orc-34", machine: "mac" }, { id: "20261113-120000-b", branch: "orc/orc-34", machine: null }], "orc-34")
  expect(runToOpen(runs, new Set(["20261113-100000-a"]))).toBe("20261113-100000-a")
})

test("shows no Open run when the local list misses the task instead of opening by machine", () => {
  const runs = runsOfTask([{ id: "20261113-120000-b", branch: "orc/orc-34", machine: null }], "orc-34")
  expect(runToOpen(runs, new Set([]))).toBeNull()
})

test("drops the title line from the description instead of repeating the header", () => {
  expect(descriptionOf("Show the selected task\n\nThe body stays.")).toBe("The body stays.")
})

test("shows no description for a title-only body instead of repeating the title", () => {
  expect(descriptionOf("Show the selected task\n")).toBe("")
})

test("gives a closed task no parked answer box instead of one that always fails", () => {
  const closed: TaskDetail = { ...fresh, parked: { branch: "orc/orc-34", questions: [asked("R3", false)] }, state: { status: "closed", account: "main", started: null, outcome: "done", pr: null, report: null, answer: null, closedAt: "2026-11-13T12:00:00.000Z" } }
  expect(threadEntries(closed).map((entry) => entry.reply)).toEqual([null])
})

test("leaves past holds out of the thread instead of repeating their questions", () => {
  const past = { reason: "old hold", until: null, at: null, questions: [asked("Q0", false)], answer: null }
  const held: TaskDetail = { ...fresh, hold: { reason: "waits for the PR", until: null, at: null, questions: [], answer: null, history: [past] } }
  expect(threadEntries(held).map((entry) => entry.what)).toEqual(["Hold"])
})

test("leaves a closed decision answer out of the thread instead of showing it again", () => {
  const closed: TaskDetail = { ...fresh, state: { status: "closed", account: "main", started: null, outcome: "done", pr: null, report: null, answer: { words: "yes", at: "2026-11-13T12:00:00.000Z" }, closedAt: "2026-11-13T12:00:00.000Z" } }
  expect(threadEntries(closed)).toEqual([])
})

test("labels a hold answer Answer instead of You", () => {
  const held: TaskDetail = { ...fresh, hold: { reason: "waits for the PR", until: null, at: null, questions: [], answer: { words: "go", at: "2026-11-13T12:00:00.000Z" }, history: [] } }
  expect(threadEntries(held).map((entry) => [entry.who, entry.what])).toEqual([["orc", "Hold"], ["Answer", "Answer"]])
})

test("refuses a backlog task with no body instead of showing an empty description", () => {
  const text = JSON.stringify({ schema: "orc.backlog.v1", tasks: [{ id: "orc-34", title: "t", kind: "ship", created: "2026-11-13T10:00:00.000Z" }] })
  expect(guardJson(text, taskDetails)).toEqual({ kind: "refused", reason: "tasks[0].body is missing" })
})
