import { expect, test } from "bun:test"
import fixture from "../../fixtures/attention/herdr-app.json"
import { guardJson } from "../../../packages/herdr-app/src/guard"
import { attention } from "../../../packages/herdr-app/src/guard-attention"
import { choice, inboxArgv, inboxItems } from "../../../packages/herdr-app/src/inbox"
import type { TaskDetail } from "../../../packages/herdr-app/src/task"

const parsed = guardJson(JSON.stringify(fixture), attention)
if (parsed.kind !== "ok") throw new Error(parsed.reason)
const { items } = parsed.value

const task: TaskDetail = {
  id: "garden-3", title: "Update the report", kind: "ship", body: "", created: "2026-11-13T10:00:00.000Z",
  priority: null, dependsOn: [], prState: "open", hold: null, parked: null,
  state: { status: "closed", account: null, started: null, outcome: "done", pr: "https://github.com/example/garden/pull/3", report: null, closedAt: "2026-11-13T12:00:00.000Z" }
}

test("a merged PR does not get a merge action from a stale attention record", () => {
  expect(inboxItems([{ ...task, prState: "merged" }], items).find((item) => item.task === task.id)).toBeUndefined()
})

test("an open PR no longer in attention does not become a fresh approval", () => {
  expect(inboxItems([task], [])).toEqual([])
})

test("holding an open PR records the choice without calling merge", () => {
  const item = inboxItems([task], items).find((entry) => entry.task === task.id)
  if (item?.kind !== "pr") throw new Error("Missing PR attention card")
  expect(inboxArgv(item, "hold")).toEqual(["attention", "answer", "garden-3.pr-ready.bbbb", "hold"])
  expect(inboxArgv(item, "merge")).toBeNull()
  expect(choice(item, { text: "merge", picture: null, letter: "A" })).toEqual({ kind: "merge" })
})

test("an answered parked question does not reappear when attention has not caught up", () => {
  const parked: TaskDetail = {
    ...task, id: "garden-8", state: { status: "new" }, prState: null,
    parked: { branch: "orc/garden-8", questions: [{
      id: "ask-1", text: "Which layout should the report use?", asked: "2026-11-25T07:48:00.000Z",
      answer: { words: "Narrow", at: "2026-11-25T07:50:00.000Z" }
    }] }
  }
  expect(inboxItems([parked], items).find((item) => item.task === parked.id)).toBeUndefined()
})

test("an unasked-question card sends nothing from the app instead of an orc attention answer that refuses it", () => {
  const unasked = {
    id: "garden-9.unasked-question.2026-11-20T22_49_20_578Z", kind: "unasked-question", task: "garden-9", owner: "user" as const,
    text: "garden-9 is parked for the captain's answer to R3, and no open item asks it", asked: "2026-11-21T21:30:00.000Z",
    subject: "the unasked questions of garden-9: R3", recommendation: "answer", decision: null, overdueSeconds: null,
    options: [{ text: "answer", outcome: "orc backlog answer garden-9 <question-id>=<text>", picture: null, action: null }, { text: "drop", outcome: "orc backlog drop garden-9 <reason>", picture: null, action: null }]
  }
  const card = inboxItems([], [unasked]).at(0)
  if (card === undefined) throw new Error("Missing unasked-question card")
  expect(card.action).toEqual({ kind: "unavailable" })
  expect(inboxArgv(card, "two fields")).toBeNull()
})
