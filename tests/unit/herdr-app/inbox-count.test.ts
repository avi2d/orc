import { expect, spyOn, test } from "bun:test"
import fixture from "../../fixtures/attention/herdr-app.json"
import type { Card } from "../../../packages/herdr-app/src/agents"
import type { BoardTask } from "../../../packages/herdr-app/src/board"
import { type Node, checkedRadio, click, cx, documents, executed, find, handlersInRows, loadAttention, nodes, openTask, press, pressRow, ran, sessionFiles, setAttentionDocuments, spawned, stalledAttention, stopped, typeIn } from "./gpui-fakes"

test("a stalled remote question request does not hold back local steps and log refresh", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const runId = "20261126-090000-aaaaaa"
  const step = { id: 1, name: "fix", attempt: 1, status: "running", model: null, thinking: null, piSessionFile: null, from: null }
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [{ id: runId, project: "/work/garden", branch: "orc/garden-1", status: "running", prLink: null, title: "Local run", step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null }] })
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", tasks: [] })
  documents.set(`orc show ${runId} --json`, { schema: "orc.show.v1", run: { taskFile: "/work/garden/task.md" }, steps: [step] })
  documents.set(`orc log ${runId} 1`, "local output")
  let release = (): void => undefined
  stalledAttention.pending = new Promise((resolve) => { release = () => resolve({ code: 0, stdout: JSON.stringify(fixture), stderr: "" }) })
  const agents = new OrcAgents()
  try {
    agents.refresh(cx)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agents.steps?.reading.kind).toBe("ok")
    expect(agents.output.log?.reading).toEqual({ kind: "ok", value: JSON.stringify("local output") })
  } finally {
    release()
    stalledAttention.pending = null
    documents.clear()
  }
})

test("pressing the open Project trigger closes its list instead of reopening it after repaint", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.menuOpen = true
  press(agents, "filter-project")
  expect(agents.menuOpen).toBe(false)
})

test("pressing the closed Project trigger opens its list instead of leaving it shut", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  press(agents, "filter-project")
  expect(agents.menuOpen).toBe(true)
})

const cmd4 = { name: "layout.select", args: { stack: "orc-views", child: "orc-inbox" } }

const task: BoardTask = {
  id: "orc-1", title: "A task", project: "orc", kind: "ship", created: "2026-01-01", status: "new", prState: null
}

test("the Awaiting you lane count on the Board opens the Inbox as cmd-4 does instead of folding the lane", async () => {
  const { default: OrcBoard } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const board = new OrcBoard()
  board.reading = { kind: "ok", value: { backlog: { tasks: [task], projects: [] }, awaiting: new Set([task.id]) } }
  ran.length = 0
  stopped.length = 0
  click(find(board.render(), "inbox-count"))
  expect(ran.filter((call) => call.name === "layout.select")).toEqual([cmd4])
  expect(stopped.length).toBe(1)
})

const queued: Card = {
  key: "garden-20", id: "garden-20", kind: "ship", delivery: null, title: "Another task", project: "garden", known: true,
  standing: { status: "Queued" }, where: "Waiting to start", runId: null, checkout: null, sendBack: null, openPr: null
}

const wordsOf = (element: object | string): ReadonlyArray<string> =>
  typeof element === "string" ? [element] : (nodes.get(element)?.kids ?? []).flatMap(wordsOf)

const wordsUnder = (element: object, id: string): ReadonlyArray<string> => find(element, id)?.kids.flatMap(wordsOf) ?? []

test("a selected Awaiting you run shows its question, options and recommendation in its Thread tab, not behind a step list", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [...data.agents.cards, queued], reread: null }
  agents.agent = data.agents.agent
  agents.selectedKey = "garden-8"
  const words = wordsOf(agents.render())
  expect(words).toContain("Thread")
  expect(words).toContain("The width of the herb bed")
  expect(words).toContain("Plant one row so the path to the kitchen door stays clear.")
  expect(words).toContain("Narrow")
  expect(words).not.toContain("Where should the bench go?")
  agents.selectedKey = "garden-7"
  const other = wordsOf(agents.render())
  expect(other).toContain("Where should the bench go?")
  expect(other).toContain("No options recorded")
})

test("pressing an option in a run's Thread puts its text in the answer box and marks it instead of sending at once", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: data.agents.cards, reread: null }
  agents.selectedKey = "garden-8"
  agents.answers.sync(cx, data.inbox.items)
  const key = "garden-8/garden-8.ask-1.2026-11-25T07_48_00_000Z"
  executed.length = 0
  click(find(agents.render(), `option-${key}-B`))
  expect(executed).toEqual([])
  expect(agents.answers.boxes.get(key)?.value()).toBe("Narrow")
  const marked = agents.render()
  expect(checkedRadio(marked, `option-${key}-B`)).toBe(true)
  expect(checkedRadio(marked, `option-${key}-A`)).toBe(false)
})

test("typing an option's number into an empty answer box picks that option instead of sending the digit", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: data.agents.cards, reread: null }
  agents.selectedKey = "garden-8"
  agents.answers.sync(cx, data.inbox.items)
  const key = "garden-8/garden-8.ask-1.2026-11-25T07_48_00_000Z"
  const box = agents.answers.boxes.get(key)
  typeIn(box, "2")
  expect(box?.value()).toBe("Narrow")
  typeIn(box, "Narrow, then 1")
  expect(box?.value()).toBe("Narrow, then 1")
  expect(checkedRadio(agents.render(), `option-${key}-B`)).toBe(false)
})

test("a failed reread keeps its Could not reread card when the agents' questions arrive after it, instead of the questions clearing it", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  setAttentionDocuments()
  try {
    await agents.readAll(cx)
    documents.delete("orc runs --json --local")
    await agents.readAll(cx)
    spawned.length = 0
    agents.refreshQuestions(cx)
    await Promise.all(spawned)
    const words = wordsOf(agents.render())
    expect(words).toContain("Could not reread the runs")
    expect(words.some((said) => said.includes("The list below is from"))).toBe(true)
  } finally {
    documents.clear()
  }
})

test("an agent's question stays in the folded Agent attention section until it is opened, not in the run list", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [...data.agents.cards, queued], reread: null }
  agents.agent = data.agents.agent
  agents.selectedKey = queued.key
  const element = agents.render()
  expect(wordsOf(element)).not.toContain("Which file format should the export use?")
  expect(wordsOf(element)).not.toContain("Two retries")
  click(find(element, "toggle-agent-attention"))
  expect(wordsOf(agents.render())).toContain("Which file format should the export use?")
})

test("a run row in the Runs list registers no press handler of its own, which the App refuses inside a virtual list row", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [...data.agents.cards, queued], reread: null }
  agents.agent = data.agents.agent
  click(find(agents.render(), "toggle-agent-attention"))
  expect(handlersInRows(agents.render())).toEqual([])
  agents.folded = true
  expect(handlersInRows(agents.render())).toEqual([])
})

test("pressing a run row through the list selects that run, not the run selected before", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [...data.agents.cards, queued], reread: null }
  agents.selectedKey = "garden-8"
  pressRow(agents.render(), "cards", `card-${queued.key}`)
  expect(agents.selectedKey).toBe(queued.key)
  agents.folded = true
  pressRow(agents.render(), "rail-ids", "garden-8")
  expect(agents.selectedKey).toBe("garden-8")
})

test("folded groups stay absent from the rail instead of offering rows that select another run", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const cards: ReadonlyArray<Card> = [
    ...data.agents.cards, queued,
    ...(["Running", "Failed", "Done"] as const).map((status) => ({
      ...queued, key: status, id: status, standing: { status }
    }))
  ]
  for (const card of cards) {
    const agents = new OrcAgents()
    agents.refresh = () => undefined
    const other: Card = { ...queued, key: "other", standing: { status: card.standing.status === "Queued" ? "Running" : "Queued" } }
    agents.list = { kind: "ok", cards: [other, card], reread: null }
    agents.selectedKey = card.key
    expect(find(agents.render(), `card-${card.key}`)).not.toBeNull()
    pressRow(agents.render(), "cards", `group-${card.standing.status}`)
    expect(find(agents.render(), `card-${card.key}`)).toBeNull()
    expect(agents.selectedCard()?.key).toBe(other.key)
    press(agents, "fold")
    expect(find(agents.render(), `rail-${card.key}`)).toBeNull()
    pressRow(agents.render(), "rail-ids", other.key)
    expect(agents.selectedCard()?.key).toBe(other.key)
    press(agents, "unfold")
    pressRow(agents.render(), "cards", `group-${card.standing.status}`)
    pressRow(agents.render(), "cards", `card-${card.key}`)
    expect(agents.selectedCard()?.key).toBe(card.key)
    press(agents, "fold")
    pressRow(agents.render(), "rail-ids", card.key)
    expect(agents.selectedCard()?.key).toBe(card.key)
  }
})

test.each([
  { name: "implement", file: null },
  { name: "implement", file: "empty-agent.jsonl" },
  { name: "fix", file: "empty-fix.jsonl" },
  { name: "review", file: "empty-review.jsonl" }
])("a failed $name step with session $file shows its log instead of an empty Turns pane", async ({ name, file }) => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const runId = "20261126-090000-aaaaaa"
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [{ ...queued, key: runId, runId, standing: { status: "Failed" } }], reread: null }
  const step = { id: 1, name, attempt: 1, status: "failed", model: "claude-opus-5-5", thinking: "high", piSessionFile: file, from: null }
  documents.set(`orc show ${runId} --json`, { schema: "orc.show.v1", run: { taskFile: "task.md" }, steps: [step] })
  const error = "Agent could not start: provider unavailable"
  documents.set(`orc log ${runId} 1`, error)
  if (file !== null) sessionFiles.set(file, "")
  try {
    await agents.readSelectedRun()
    expect(executed).toContain(`orc log ${runId} 1`)
    expect(wordsUnder(agents.render(), "log")).toContain(JSON.stringify(error))
    expect(wordsOf(agents.render())).not.toContain("No turn yet. Pi writes its session after its first reply.")
  } finally {
    documents.clear()
    sessionFiles.clear()
  }
})

test("a Pi session's first reply replaces the startup log instead of leaving the step in log view", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const runId = "20261126-090000-aaaaaa"
  const file = "agent-session.jsonl"
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [{ ...queued, key: runId, runId, standing: { status: "Running" } }], reread: null }
  const step = { id: 1, name: "implement", attempt: 1, status: "running", model: "claude-opus-5-5", thinking: "high", piSessionFile: file, from: null }
  documents.set(`orc show ${runId} --json`, { schema: "orc.show.v1", run: { taskFile: "task.md" }, steps: [step] })
  documents.set(`orc log ${runId} 1`, "Starting agent")
  sessionFiles.set(file, "")
  try {
    await agents.readSelectedRun()
    expect(find(agents.render(), "log")).not.toBeNull()
    sessionFiles.set(file, JSON.stringify({
      type: "message", id: "reply-1", parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "Ready to work" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, timestamp: 0 }
    }) + "\n")
    executed.length = 0
    await agents.readSelectedRun()
    expect(find(agents.render(), "turn-reply-1")).not.toBeNull()
    expect(find(agents.render(), "log")).toBeNull()
    expect(executed).not.toContain(`orc log ${runId} 1`)
  } finally {
    documents.clear()
    sessionFiles.clear()
  }
})

test("an Inbox choice sends the option text to the right question once instead of sending the outcome or both options", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { inbox } = await loadAttention()
  const view = new OrcInbox()
  const { InboxAnswers } = await import("../../../packages/herdr-app/src/inbox-view")
  view.answers = new InboxAnswers(() => undefined)
  view.reading = { kind: "ok", value: inbox }
  const element = view.render()
  expect(wordsOf(element)).not.toContain("Two retries")
  click(find(element, "toggle-agent-attention"))
  const opened = wordsOf(view.render())
  expect(wordsUnder(view.render(), "decided-by-agent")).toContain("Two retries")
  expect(opened).toContain("The task says to retry twice.\ntask garden-10: “Retry a failed upload twice.”")
  const command = "orc backlog answer garden-8 ask-1=Narrow"
  documents.set(command, "answered")
  executed.length = 0
  spawned.length = 0
  const option = find(element, "option-garden-8/garden-8.ask-1.2026-11-25T07_48_00_000Z-B")
  try {
    click(option)
    click(option)
    await Promise.all(spawned)
    expect(executed).toEqual([command])
    expect(wordsOf(view.render())).toContain("Answer recorded")
  } finally {
    documents.clear()
  }
})


test("the Inbox registers its option, Send and fold handlers outside a virtual list row, which the App refuses and then draws nothing", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { inbox } = await loadAttention()
  const view = new OrcInbox()
  view.reading = { kind: "ok", value: inbox }
  view.answers.sync(cx, inbox.items)
  expect(find(view.render(), "toggle-agent-attention")).not.toBeNull()
  expect(handlersInRows(view.render())).toEqual([])
})

test("a scroll past the drawn Inbox cards redraws them on the next tick instead of leaving blank spacers until the next reload", async () => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { inbox } = await loadAttention()
  const view = new OrcInbox()
  view.reading = { kind: "ok", value: inbox }
  view.visible = true
  view.answers.sync(cx, inbox.items)
  let offset = 0
  Object.assign(view.scroll, { offset: () => ({ x: 0, y: offset }), viewport_size: () => ({ width: 720, height: 100 }) })
  const measure = (element: object): void => {
    for (const made of walk(element)) {
      const handler = made.calls.find((call) => call.name === "on_size_change")?.args[0]
      if (typeof handler === "function") handler({ width: 720, height: 300 }, cx)
    }
  }
  measure(view.render())
  const third = inbox.items[2]
  if (third === undefined) throw new Error("The fixture has fewer than three Inbox items")
  expect(find(view.render(), `space-${third.key}`)).not.toBeNull()
  const notify = spyOn(cx, "notify")
  try {
    view.tick(cx)
    expect(notify).toHaveBeenCalledTimes(0)
    offset = 16 + 2 * 312
    view.tick(cx)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(find(view.render(), `item-${third.key}`)).not.toBeNull()
    view.tick(cx)
    expect(notify).toHaveBeenCalledTimes(1)
    offset = 0
    view.tick(cx)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(find(view.render(), `item-${inbox.items[0]?.key ?? ""}`)).not.toBeNull()
    view.visible = false
    offset = 16 + 2 * 312
    view.tick(cx)
    expect(notify).toHaveBeenCalledTimes(2)
  } finally {
    notify.mockRestore()
  }
})

const walk = (element: object | string): ReadonlyArray<Node> => {
  const made = typeof element === "string" ? undefined : nodes.get(element)
  return made === undefined ? [] : [made, ...made.kids.flatMap(walk)]
}

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
