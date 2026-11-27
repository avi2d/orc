import { expect, test } from "bun:test"
import type OrcAgents from "../../../packages/herdr-app/mods/orc-agents/main"
import type { Card } from "../../../packages/herdr-app/src/agents"
import type { LocalAgents } from "../../../packages/herdr-app/src/agents-read"
import type { InboxAnswer } from "../../../packages/herdr-app/src/inbox"
import type { TaskDetail } from "../../../packages/herdr-app/src/task"
import type { ThreadLine } from "../../../packages/herdr-app/src/thread"
import { click, cx, documents, executed, find, nodes, spawned, typeIn } from "./gpui-fakes"

const wordsOf = (element: object | string): ReadonlyArray<string> =>
  typeof element === "string" ? [element] : (nodes.get(element)?.kids ?? []).flatMap(wordsOf)

const idle = () => ({ cancel: () => undefined, is_done: () => true })
const idleCx = Object.assign(class extends cx {}, { spawn: idle, timer: { ...cx.timer, every: idle } })

const localFor = (detail: TaskDetail): LocalAgents => ({
  details: [detail], backlog: { schema: "orc.backlog.v1", tasks: [], projects: [], merged: [] },
  runs: { schema: "orc.runs.v1", runs: [] }
})

const done = (id: string, title: string): Card => ({
  key: id, id, title, project: "garden", known: true, kind: "ship", delivery: null,
  standing: { status: "Done" }, where: "PR ready", runId: id, checkout: null,
  sendBack: id, openPr: "https://github.com/example/garden/pull/8"
})

test.each([true, false])("Find does not carry another run's draft or Changes into the result (draft: %s)", async (drafting) => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  let refreshes = 0
  agents.refresh = () => { refreshes++ }
  agents.init(null, idleCx)
  agents.list = { kind: "ok", cards: [done("garden-1", "Alpha"), done("garden-2", "Beta")], reread: null }
  expect(agents.selectedCard()?.key).toBe("garden-1")
  if (drafting) {
    click(find(agents.render(cx), "tab-approve"))
    typeIn(agents.review, "Fix Alpha")
  }
  agents.told = { of: "garden-1", reading: { kind: "ok", value: { task: "garden-1", entries: [] } } }
  agents.changesProblem = "Alpha's checkout is unavailable"
  agents.shareChanges({ worktree: "/work/alpha", branch: "orc/garden-1", base: "main", files: [] })
  const before = refreshes
  typeIn(agents.find, "Beta")
  expect(agents.selectedCard()?.key).toBe("garden-2")
  expect(agents.chosen).toBeNull()
  expect(agents.review.value()).toBe("")
  expect(agents.told).toBeNull()
  expect(agents.changesProblem).toBeNull()
  expect(agents.sharedChanges).toBe("null")
  expect(agents.changesShown).toBe(false)
  expect(agents.selectedKey).toBe("garden-2")
  expect(refreshes).toBe(before + 1)
  executed.length = 0
  agents.sendBack(cx)
  expect(executed).toEqual([])
  typeIn(agents.review, "Fix Beta")
  typeIn(agents.find, "Bet")
  expect(agents.review.value()).toBe("Fix Beta")
  const command = "orc backlog send-back garden-2 Fix Beta"
  documents.set(command, "sent back")
  spawned.length = 0
  try {
    agents.sendBack(cx)
    await Promise.all(spawned)
    expect(executed).toEqual([command])
    agents.shareChanges({ worktree: "/work/beta", branch: "orc/garden-2", base: "main", files: [] })
    typeIn(agents.find, "Alpha")
    expect(agents.selectedKey).toBe("garden-1")
    expect(agents.sharedChanges).toBe("null")
    agents.shareChanges({ worktree: "/work/alpha", branch: "orc/garden-1", base: "main", files: [] })
    typeIn(agents.find, "No such run")
    expect(agents.selectedKey).toBeNull()
    expect(agents.sharedChanges).toBe("null")
  } finally {
    documents.clear()
  }
})

test("Find resets the open tab and the run's state while it keeps the same run selected", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.refresh = () => undefined
  agents.init(null, idleCx)
  agents.list = { kind: "ok", cards: [done("garden-1", "Alpha"), done("garden-2", "Beta")], reread: null }
  click(find(agents.render(cx), "tab-approve"))
  typeIn(agents.review, "Fix Alpha")
  const told = { of: "garden-1", reading: { kind: "ok", value: { task: "garden-1", entries: [] } } } as const
  agents.told = told
  agents.changesProblem = "Alpha's checkout is unavailable"
  agents.shareChanges({ worktree: "/work/alpha", branch: "orc/garden-1", base: "main", files: [] })
  const shared = agents.sharedChanges
  typeIn(agents.find, "Alp")
  typeIn(agents.find, "Alph")
  expect(agents.selectedKey).toBe("garden-1")
  expect(agents.chosen).toEqual({ kind: "approve" })
  expect(agents.review.value()).toBe("Fix Alpha")
  expect(agents.told).toBe(told)
  expect(agents.changesProblem).toBe("Alpha's checkout is unavailable")
  expect(agents.sharedChanges).toBe(shared)
})

const at = "2026-11-25T07:48:00.000Z"
const questionId = "garden-8.ask-1.2026-11-25T07_48_00_000Z"
const question: InboxAnswer = {
  key: `garden-8/${questionId}`, task: "garden-8", title: "Herb bed", who: "worker", asked: at,
  kind: "question", recommendation: null, action: { kind: "answer", target: { kind: "question", id: "ask-1" } },
  ask: { question: "How many retries?", context: null, options: [
    { letter: "A", text: "One retry", picture: null },
    { letter: "B", text: "Write an answer", picture: null, action: "write-answer" },
    { letter: "C", text: "Three retries", picture: null }
  ] }
}

test.each([
  { hold: false, numbered: false }, { hold: false, numbered: true },
  { hold: true, numbered: false }, { hold: true, numbered: true }
])("a digit in a written answer does not select another option (hold: $hold, numbered: $numbered)", async ({ hold, numbered }) => {
  const { InboxAnswers, threadBoxes } = await import("../../../packages/herdr-app/src/inbox-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const answers = new InboxAnswers(() => undefined, threadBoxes)
  const item: InboxAnswer = hold ? {
    ...question, kind: "hold", action: { kind: "overdue-hold" },
    ask: { ...question.ask, options: [
      { letter: "A", text: "answer", picture: null },
      { letter: "B", text: "drop", picture: null },
      { letter: "C", text: "wait", picture: null, action: "wait" }
    ] }
  } : question
  answers.sync(cx, [item])
  const render = () => answers.askCard(palette(), item, () => undefined)
  const box = answers.boxes.get(item.key)
  if (numbered) typeIn(box, "2")
  else click(find(render(), `option-${item.key}-B`))
  typeIn(box, "1")
  expect(box?.value()).toBe("1")
  expect(answers.writing.get(item.key)?.prefix).toBe(hold ? "drop" : "")
  const words = "1 retry is enough"
  typeIn(box, words)
  const command = hold ? `orc backlog drop garden-8 ${words}` : `orc backlog answer garden-8 ask-1=${words}`
  documents.set(command, "answered")
  executed.length = 0
  spawned.length = 0
  try {
    click(find(render(), `send-${item.key}`))
    await Promise.all(spawned)
    expect(executed).toEqual([command])
  } finally {
    documents.clear()
  }
})

const task: TaskDetail = {
  id: "garden-8", title: "Herb bed", kind: "ship", body: "", created: at, priority: null,
  parent: null, dependsOn: [], prState: null, hold: null, parked: null, state: { status: "new" }
}

type Agents = InstanceType<typeof OrcAgents>

const showsEachOnce = (agents: Agents, items: ReadonlyArray<InboxAnswer>, entries: ReadonlyArray<ThreadLine>): void => {
  agents.told = { of: task.id, reading: { kind: "ok", value: { task: task.id, entries } } }
  agents.answers.sync(cx, items)
  const words = wordsOf(agents.render(cx))
  expect(words.filter((word) => word === "How many retries?")).toHaveLength(1)
  expect(words.filter((word) => word === "Where should the bench go?")).toHaveLength(1)
}

test.each(["question", "hold", "overdue"] as const)("a %s answer is drawn twice, as a hold entry and as its card, or hides another question", async (kind) => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.refresh = () => undefined
  const item: InboxAnswer = {
    ...question, kind: "hold", key: "garden-8/hold/current",
    ...(kind === "overdue" ? { asked: "2026-11-25T00:00:00.000Z" } : {}),
    action: kind === "overdue" ? { kind: "overdue-hold" }
      : { kind: "answer", target: kind === "question" ? { kind: "question", id: "question-1" } : { kind: "hold" } }
  }
  const heldTask: TaskDetail = {
    ...task, hold: { at, reason: "How many retries?", until: kind === "overdue" ? "2026-11-24" : null, answer: null,
      questions: kind === "question" ? [{ id: "question-1", text: "How many retries?", asked: at, answer: null }] : [] }
  }
  const entry: ThreadLine = {
    at, who: "user", kind: kind === "question" ? "question" : "hold",
    id: kind === "question" ? "hold-2/question-1" : null, text: "How many retries?"
  }
  const earlier: ThreadLine = {
    at: "2026-11-24T07:48:00.000Z", who: "user", kind: "question", id: "hold-1/question-1", text: "Where should the bench go?"
  }
  agents.local = localFor(heldTask)
  agents.list = { kind: "ok", cards: [{
    ...done("garden-8", "Herb bed"), standing: { status: "Awaiting you", waiting: { on: "answer", items: [item] } }
  }], reread: null }
  showsEachOnce(agents, [item], [earlier, entry])
})

const ownQuestion: ThreadLine = { at, who: "worker", kind: "question", id: questionId, text: "How many retries?" }
const otherQuestion: ThreadLine = {
  at, who: "user", kind: "question", id: "hold-1/question-1", text: "Where should the bench go?"
}

test.each(["Running", "Failed", "Done", "Queued", "Awaiting you"] as const)("the %s Thread does not hide an open question owned by another card", async (status) => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.refresh = () => undefined
  const standing = status === "Awaiting you" ? {
    status, waiting: { on: "approval", item: {
      ...question, kind: "pr", link: "https://github.com/example/garden/pull/8",
      action: { kind: "merge", argv: ["merge", "garden-8"] }
    } }
  } as const : { status }
  agents.list = { kind: "ok", cards: [{ ...done("garden-8", "Herb bed"), standing }], reread: null }
  agents.local = localFor(task)
  agents.told = { of: task.id, reading: { kind: "ok", value: { task: task.id, entries: [otherQuestion] } } }
  click(find(agents.render(cx), "tab-thread"))
  const rendered = agents.render(cx)
  expect(wordsOf(rendered)).toContain("Where should the bench go?")
  expect(find(rendered, "send-back")).toBeNull()
  expect(agents.answers.boxes.size).toBe(0)
})

test("an answer card's Thread does not hide a different open question or duplicate its own", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.refresh = () => undefined
  agents.list = { kind: "ok", cards: [{
    ...done("garden-8", "Herb bed"), standing: { status: "Awaiting you", waiting: { on: "answer", items: [question] } }
  }], reread: null }
  agents.local = localFor(task)
  showsEachOnce(agents, [question], [ownQuestion, otherQuestion])
})
