import { expect, test } from "bun:test"
import fixture from "../../fixtures/attention/herdr-app.json"
import { type Node, click, cx, documents, executed, find, loadAttention, nodes, openTask, spawned, wordsOf, wordsUnder } from "./gpui-fakes"

const idsIn = (lane: Node | null): ReadonlyArray<string> =>
  (lane?.kids ?? []).flatMap((kid) => typeof kid === "string" ? [] : (nodes.get(kid)?.calls ?? []).flatMap((call) => call.name === "id" ? [String(call.args[0])] : []))

test("the Board's Awaiting you lane lists the tasks the Inbox lists instead of a task parked on an agent's question or a closed task with an open PR", async () => {
  const { default: OrcBoard } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  const parked = {
    ...openTask("garden-9"),
    parked: { branch: "orc/garden-9", questions: [{ id: "ask-1", text: "Which file format should the export use?", asked: "2026-11-25T07:59:00.000Z", answer: null }] }
  }
  const closed = {
    ...openTask("garden-11"), status: "closed", prState: "open", claim: null, started: null, outcome: "done",
    pr: "https://github.com/example/garden/pull/11", report: null, closedAt: "2026-11-24T09:00:00Z"
  }
  documents.set("orc backlog --json", {
    schema: "orc.backlog.v1", projects: [{ name: "garden" }],
    tasks: [...["garden-2", "garden-3", "garden-7", "garden-8"].map(openTask), parked, closed]
  })
  documents.set("orc attention --json", fixture)
  const board = new OrcBoard()
  const [reading, inbox] = await Promise.all([board.load(), readInbox()]).finally(() => documents.clear())
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  board.reading = reading
  const element = board.render()
  const userOwned = ["garden-2", "garden-3", "garden-7", "garden-8"]
  expect([...new Set(inbox.value.items.map((item) => item.task))].sort()).toEqual(userOwned)
  expect(idsIn(find(element, "cards-Awaiting you"))).toEqual(userOwned.map((id) => `card-${id}`))
  expect(find(element, "inbox-count")?.kids).toEqual(["4"])
  expect(idsIn(find(element, "cards-Planned"))).toEqual(["card-garden-9"])
})

test("a hold kept until a parked child closes shows what it waits on across the Inbox, Agents and Board instead of an Awaiting you answer box", async () => {
  const { default: OrcBoard } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const { readAgents } = await import("../../../packages/herdr-app/src/agents-read")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  const reason = "Done by a firstmate worker in https://github.com/avi2d/orc/pull/317; held until its parked child orc-78 is closed, then dropped"
  const held = { ...openTask("orc-74"), project: "orc", kind: "parent", hold: { reason, until: null, at: "2026-11-25T10:00:00Z", questions: [], answer: null } }
  const child = {
    ...openTask("orc-78"), project: "orc", parent: "orc-74",
    parked: { branch: "orc/orc-78", questions: [{ id: "R4", text: "Should approval badges also derive from the PR item?", asked: "2026-11-25T09:00:00Z", answer: null }] }
  }
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", projects: [{ name: "orc" }], tasks: [held, child] })
  documents.set("orc attention --json", { ...fixture, items: [], decided: [] })
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
  const board = new OrcBoard()
  const [reading, inbox, agents] = await Promise.all([board.load(), readInbox(), readAgents()]).finally(() => documents.clear())
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  if (agents.kind !== "ok") throw new Error(agents.kind === "failed" ? agents.reason : agents.kind)
  expect(inbox.value.items.filter((item) => item.task === held.id)).toEqual([])
  expect(agents.value.cards.find((card) => card.id === held.id)).toMatchObject({ standing: { status: "Queued" }, where: "Waits on orc-78" })
  board.reading = reading
  expect(idsIn(find(board.render(), "cards-Planned"))).toEqual(["card-orc-74", "card-orc-78"])
})

test("a hold on a parent whose ship child closed with its PR still open names the child in the task panel instead of an answer box", async () => {
  const { default: OrcTask } = await import("../../../packages/herdr-app/mods/orc-task/main")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  const { guardJson } = await import("../../../packages/herdr-app/src/guard")
  const { taskDetails } = await import("../../../packages/herdr-app/src/task-guard")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const reason = "held until its child orc-78 merges"
  const held = { ...openTask("orc-74"), project: "orc", kind: "parent", hold: { reason, until: null, at: "2026-11-25T10:00:00Z", questions: [], answer: null } }
  const child = {
    ...openTask("orc-78"), project: "orc", parent: "orc-74", prState: "open", status: "closed", claim: null, started: null, outcome: "done",
    pr: "https://github.com/avi2d/orc/pull/317", report: null, closedAt: "2026-11-25T11:00:00Z"
  }
  const backlog = { schema: "orc.backlog.v1", projects: [{ name: "orc" }], tasks: [held, child] }
  documents.set("orc backlog --json", backlog)
  documents.set("orc attention --json", { ...fixture, items: [], decided: [] })
  const inbox = await readInbox().finally(() => documents.clear())
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  expect(inbox.value.items.filter((item) => item.task === held.id)).toEqual([])
  const parsed = guardJson(JSON.stringify(backlog), taskDetails)
  if (parsed.kind !== "ok") throw new Error(parsed.reason)
  const detail = parsed.value.find((other) => other.id === held.id)
  if (detail === undefined) throw new Error("Missing orc-74")
  const hold = { at: "2026-11-25T10:00:00Z", who: "user" as const, kind: "hold" as const, id: null, text: reason }
  const panel = new OrcTask()
  panel.reading = { kind: "ok", value: { tasks: parsed.value, runs: [], queued: [], local: [], thread: { kind: "ok", value: { task: held.id, entries: [hold] } } } }
  expect(panel.makeBoxes(detail)).toBe(false)
  const thread = panel.tabBody(palette(), detail, [])
  expect(wordsOf(thread)).toContain("Waits on orc-78")
  expect(find(thread, `send-hold-${hold.at}`)).toBeNull()
})

test("a PR with no recorded state remains actionable across the Inbox, Board and task panel instead of losing its merge button", async () => {
  const { default: OrcBoard } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const { default: OrcTask } = await import("../../../packages/herdr-app/mods/orc-task/main")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  const { guardJson } = await import("../../../packages/herdr-app/src/guard")
  const { taskDetails } = await import("../../../packages/herdr-app/src/task-guard")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const closed = {
    ...openTask("garden-3"), status: "closed", prState: null, claim: null, started: null, outcome: "done",
    pr: "https://github.com/example/garden/pull/3", report: null, closedAt: "2026-11-24T09:00:00Z"
  }
  const backlog = { schema: "orc.backlog.v1", projects: [{ name: "garden" }], tasks: [closed] }
  documents.set("orc backlog --json", backlog)
  documents.set("orc attention --json", fixture)
  const board = new OrcBoard()
  const [reading, inbox] = await Promise.all([board.load(), readInbox()]).finally(() => documents.clear())
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  const parsed = guardJson(JSON.stringify(backlog), taskDetails)
  if (parsed.kind !== "ok") throw new Error(parsed.reason)
  const detail = parsed.value[0]
  expect(inbox.value.items.find((item) => item.task === closed.id)).toMatchObject({ kind: "pr", link: closed.pr, action: { kind: "merge" } })
  board.reading = reading
  expect(idsIn(find(board.render(), "cards-Awaiting you"))).toEqual(["card-garden-3"])
  const panel = new OrcTask()
  panel.tab = "Info"
  const info = panel.tabBody(palette(), detail, [])
  expect(wordsOf(info)).toContain(closed.pr)
  expect(wordsOf(info)).not.toContain(`${closed.pr} (open)`)
  expect(find(info, "merge")).not.toBeNull()
})

test("an Inbox question with options also sends a typed answer instead of offering only the option buttons", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { InboxAnswers } = await import("../../../packages/herdr-app/src/inbox-view")
  const { inbox } = await loadAttention()
  const view = new OrcInbox()
  view.answers = new InboxAnswers(() => undefined)
  view.reading = { kind: "ok", value: inbox }
  view.answers.sync(cx, inbox.items)
  const key = "garden-8/garden-8.ask-1.2026-11-25T07_48_00_000Z"
  const element = view.render()
  expect(find(element, `option-${key}-A`)).not.toBeNull()
  view.answers.boxes.get(key)?.set_value("Wide, but only on desktop")
  const command = "orc backlog answer garden-8 ask-1=Wide, but only on desktop"
  documents.set(command, "answered")
  executed.length = 0
  spawned.length = 0
  try {
    click(find(element, `send-${key}`))
    await Promise.all(spawned)
    expect(executed).toEqual([command])
  } finally {
    documents.clear()
  }
})

test("an answer you gave in place of the agent's stays in the collapsed Agent attention section instead of above it", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { inboxDocuments } = await import("../../../packages/herdr-app/src/inbox-read")
  const { guardJson } = await import("../../../packages/herdr-app/src/guard")
  const { attention } = await import("../../../packages/herdr-app/src/guard-attention")
  const replaced = {
    ...fixture,
    decided: fixture.decided.map((item) => ({ ...item, decision: { ...item.decision, decider: "agent" }, answer: { decider: "owner", words: "Three retries", at: "2026-11-25T07:59:00.000Z" }, overturned: { decider: "agent", words: "Two retries", at: "2026-11-25T07:58:00.000Z" } }))
  }
  const queue = guardJson(JSON.stringify(replaced), attention)
  if (queue.kind !== "ok") throw new Error(queue.reason)
  const view = new OrcInbox()
  view.reading = { kind: "ok", value: inboxDocuments([], queue.value) }
  const closed = wordsOf(view.render())
  expect(closed).not.toContain("Decided by the owner")
  expect(closed).not.toContain("Three retries")
  click(find(view.render(), "toggle-agent-attention"))
  const owner = wordsUnder(view.render(), "decided-by-owner")
  const agent = wordsUnder(view.render(), "decided-by-agent")
  expect(owner).toContain("Three retries")
  expect(owner).not.toContain("Two retries")
  expect(agent).toContain("Two retries")
  expect(agent).not.toContain("Three retries")
})

test("an owner answer and an agent answer open under their own Decided by headings, with the agent's basis, rather than in one mixed list", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { inboxDocuments } = await import("../../../packages/herdr-app/src/inbox-read")
  const { guardJson } = await import("../../../packages/herdr-app/src/guard")
  const { attention } = await import("../../../packages/herdr-app/src/guard-attention")
  const ownerAnswered = {
    id: "garden-11.question-1.2026-11-25T07_50_00_000Z", kind: "review-question", task: "garden-11", text: "Which mulch goes on the bed?",
    asked: "2026-11-25T07:50:00.000Z", owner: "user", answer: { decider: "owner", words: "Bark mulch", at: "2026-11-25T07:55:00.000Z" }
  }
  const queue = guardJson(JSON.stringify({ ...fixture, decided: [...fixture.decided, ownerAnswered] }), attention)
  if (queue.kind !== "ok") throw new Error(queue.reason)
  const view = new OrcInbox()
  view.reading = { kind: "ok", value: inboxDocuments([], queue.value) }
  click(find(view.render(), "toggle-agent-attention"))
  const owner = wordsUnder(view.render(), "decided-by-owner")
  const agent = wordsUnder(view.render(), "decided-by-agent")
  expect(owner).toEqual(expect.arrayContaining(["Decided by the owner", "garden-11", "Which mulch goes on the bed?", "Bark mulch"]))
  expect(owner).not.toContain("Two retries")
  expect(agent).toEqual(expect.arrayContaining(["Decided by the agent", "garden-10", "Two retries", "The task says to retry twice.\ntask garden-10: “Retry a failed upload twice.”"]))
  expect(agent).not.toContain("Bark mulch")
})

test("an agent escalation the owner then answered lists under Decided by the agent with its basis, not only the owner's answer", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { inboxDocuments } = await import("../../../packages/herdr-app/src/inbox-read")
  const { guardJson } = await import("../../../packages/herdr-app/src/guard")
  const { attention } = await import("../../../packages/herdr-app/src/guard-attention")
  const escalated = {
    id: "garden-7.question-3.2026-11-25T07_00_00_000Z", kind: "review-question", task: "garden-7", text: "Where does the bench go?",
    asked: "2026-11-25T07:00:00.000Z", owner: "user",
    decision: { kind: "escalated", reason: "The task does not say where the bench goes.", at: "2026-11-25T07:01:00.000Z", decider: "agent" },
    answer: { decider: "owner", words: "By the pond", at: "2026-11-25T07:05:00.000Z" }
  }
  const queue = guardJson(JSON.stringify({ ...fixture, decided: [...fixture.decided, escalated] }), attention)
  if (queue.kind !== "ok") throw new Error(queue.reason)
  const view = new OrcInbox()
  view.reading = { kind: "ok", value: inboxDocuments([], queue.value) }
  click(find(view.render(), "toggle-agent-attention"))
  const owner = wordsUnder(view.render(), "decided-by-owner")
  const agent = wordsUnder(view.render(), "decided-by-agent")
  expect(owner).toEqual(expect.arrayContaining(["garden-7", "By the pond"]))
  expect(owner).not.toContain("The task does not say where the bench goes.")
  expect(agent).toEqual(expect.arrayContaining(["garden-7", "Where does the bench go?", "Escalated to the owner", "The task does not say where the bench goes."]))
  expect(agent).not.toContain("By the pond")
})

test("the task panel Thread lists an owner answer and an agent answer under their own Decided by headings, with the agent's basis, instead of only in time order", async () => {
  const { default: OrcTask } = await import("../../../packages/herdr-app/mods/orc-task/main")
  const { guardJson } = await import("../../../packages/herdr-app/src/guard")
  const { taskDetails, thread } = await import("../../../packages/herdr-app/src/task-guard")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const tasks = guardJson(JSON.stringify({ schema: "orc.backlog.v1", projects: [{ name: "garden" }], tasks: [openTask("garden-12")] }), taskDetails)
  if (tasks.kind !== "ok") throw new Error(tasks.reason)
  const asked = (n: number) => `garden-12.question-${n}.2026-11-25T07_5${n}_00_000Z`
  const told = guardJson(JSON.stringify({
    schema: "orc.thread.v1", task: "garden-12", entries: [
      { at: "2026-11-25T07:51:00.000Z", who: "worker", kind: "question", id: asked(1), text: "Which mulch goes on the bed?" },
      { at: "2026-11-25T07:51:30.000Z", who: "user", kind: "answer", id: asked(1), text: "Bark mulch" },
      { at: "2026-11-25T07:52:00.000Z", who: "worker", kind: "question", id: asked(2), text: "How many times should the run retry?" },
      { at: "2026-11-25T07:52:10.000Z", who: "decider", kind: "decision", id: asked(2), text: "answered: The task says to retry twice." },
      { at: "2026-11-25T07:52:20.000Z", who: "decider", kind: "answer", id: asked(2), text: "Two retries" },
      { at: "2026-11-25T07:53:00.000Z", who: "worker", kind: "question", id: asked(3), text: "Where does the bench go?" },
      { at: "2026-11-25T07:53:10.000Z", who: "decider", kind: "decision", id: asked(3), text: "escalated: The task does not say where the bench goes." }
    ]
  }), thread)
  if (told.kind !== "ok") throw new Error(told.reason)
  const panel = new OrcTask()
  panel.reading = { kind: "ok", value: { tasks: tasks.value, runs: [], queued: [], local: [], thread: told } }
  const body = panel.tabBody(palette(), tasks.value[0], [])
  const owner = wordsUnder(body, "decided-by-owner")
  const agent = wordsUnder(body, "decided-by-agent")
  expect(owner).toEqual(expect.arrayContaining(["Decided by the owner", "Bark mulch"]))
  expect(owner).not.toContain("Two retries")
  expect(agent).toEqual(expect.arrayContaining(["Decided by the agent", "Two retries", "answered: The task says to retry twice.", "escalated: The task does not say where the bench goes."]))
  expect(agent).not.toContain("Bark mulch")
})
