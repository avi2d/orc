import { expect, test } from "bun:test"
import { guardJson } from "../../../packages/herdr-app/src/guard"
import { type TaskDetail, answerArgv } from "../../../packages/herdr-app/src/task"
import { thread } from "../../../packages/herdr-app/src/task-guard"
import { type ThreadLine, askText, optionShape, threadCards } from "../../../packages/herdr-app/src/thread"

const started: TaskDetail = {
  id: "orc-16",
  title: "Ask with pictures",
  kind: "ship",
  body: "",
  created: "2026-11-13T10:00:00.000Z",
  priority: null,
  dependsOn: [],
  prState: null,
  hold: null,
  parked: null,
  state: { status: "started", account: "main", started: "2026-11-13T10:05:00.000Z" }
}

const askId = "orc-16.ask-1.2026-11-13T11_00_00_000Z"

const line = (kind: ThreadLine["kind"], who: ThreadLine["who"], id: string | null, text: string, at: string | null = "2026-11-13T11:00:00.000Z"): ThreadLine =>
  ({ at, who, kind, id, text })

const pictureAsk = line("question", "worker", askId, "Which layout?\nContext: Two drafts are ready.\nA) Wide (picture: /tmp/wide.png)\nB) Narrow (picture: /tmp/narrow.png)\nC) Neither")

test("shows picture options as tiles and text options as buttons instead of one shape for all", () => {
  const ask = askText(pictureAsk.text)
  expect(ask.question).toBe("Which layout?")
  expect(ask.context).toBe("Two drafts are ready.")
  expect(ask.options.map(optionShape)).toEqual([{ kind: "tile", picture: "/tmp/wide.png" }, { kind: "tile", picture: "/tmp/narrow.png" }, { kind: "button" }])
})

test("keeps a question with lines that only look like options whole instead of cutting options out of it", () => {
  const ask = askText("Pick one\nB) second")
  expect(ask.options).toEqual([])
  expect(ask.question).toBe("Pick one\nB) second")
})

test("answers a clicked worker option through orc backlog answer with the ask id instead of the attention item id", () => {
  const [card] = threadCards({ task: "orc-16", entries: [pictureAsk] }, started)
  const reply = card?.reply ?? null
  expect(reply).toEqual({ kind: "question", id: "ask-1" })
  expect(reply === null ? null : answerArgv("orc-16", reply, "Wide")).toEqual(["backlog", "answer", "orc-16", "ask-1=Wide"])
})

test("indents a decider note under its question instead of as its own entry", () => {
  const decision = line("decision", "decider", askId, "escalated: needs the captain's eye", "2026-11-13T11:01:00.000Z")
  const cards = threadCards({ task: "orc-16", entries: [pictureAsk, decision] }, started)
  expect(cards.map((card) => card.key)).toEqual([`question-${askId}`])
  expect(cards[0]?.notes).toEqual([decision])
})

test("marks an answered question delivered only after the delivered entry instead of on the answer alone", () => {
  const answer = line("answer", "user", askId, "Wide", "2026-11-13T11:02:00.000Z")
  const answered = threadCards({ task: "orc-16", entries: [pictureAsk, answer] }, started)[0]
  expect([answered?.answers, answered?.delivered, answered?.reply]).toEqual([[answer], false, null])
  const delivered = threadCards({ task: "orc-16", entries: [pictureAsk, answer, line("delivered", "beat", askId, "handed to the run that asked", null)] }, started)[0]
  expect(delivered?.delivered).toBe(true)
})

test("answers a hold question by its id without the hold generation instead of the thread id", () => {
  const held: TaskDetail = { ...started, state: { status: "new" }, hold: { reason: "pick", until: null, at: null, questions: [{ id: "question-1", text: "Which?", asked: null, answer: null }], answer: null } }
  const cards = threadCards({ task: "orc-16", entries: [line("hold", "user", null, "pick"), line("question", "user", "hold-2/question-1", "Which?")] }, held)
  expect(cards.map((card) => card.reply)).toEqual([null, { kind: "question", id: "question-1" }])
})

test("gives the current hold without questions one box instead of none", () => {
  const held: TaskDetail = { ...started, state: { status: "new" }, hold: { reason: "waits", until: null, at: null, questions: [], answer: null } }
  expect(threadCards({ task: "orc-16", entries: [line("hold", "user", null, "waits")] }, held).map((card) => card.reply)).toEqual([{ kind: "hold" }])
})

test("gives a closed task no answer box instead of one that always fails", () => {
  const closed: TaskDetail = { ...started, state: { status: "closed", account: "main", started: null, outcome: "done", pr: null, report: null, closedAt: "2026-11-13T12:00:00.000Z" } }
  expect(threadCards({ task: "orc-16", entries: [pictureAsk] }, closed).map((card) => card.reply)).toEqual([null])
})

test("refuses a thread entry of an unknown kind instead of showing it as plain text", () => {
  const text = JSON.stringify({ schema: "orc.thread.v1", task: "orc-16", entries: [{ at: null, who: "beat", kind: "shout", id: null, text: "x" }] })
  expect(guardJson(text, thread)).toEqual({ kind: "refused", reason: "entries[0].kind is \"shout\", not \"hold\" or \"question\" or \"decision\" or \"answer\" or \"delivered\" or \"withdrawn\" or \"note\"" })
})
