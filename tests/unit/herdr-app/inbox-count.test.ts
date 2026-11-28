import { expect, spyOn, test } from "bun:test"
import fixture from "../../fixtures/attention/herdr-app.json"
import type { Card } from "../../../packages/herdr-app/src/agents"
import type { BoardTask } from "../../../packages/herdr-app/src/board"
import { type Node, checkedRadio, click, cx, documents, executed, find, handlersInRows, loadAttention, nodes, press, pressRow, ran, sessionFiles, setAttentionDocuments, spawned, stalledAttention, stopped, typeIn, wordsOf, wordsUnder } from "./gpui-fakes"

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

const pathTo = (element: object | string, id: string): ReadonlyArray<Node> => {
  const made = typeof element === "string" ? undefined : nodes.get(element)
  if (made === undefined) return []
  if (made.calls.some((call) => call.name === "id" && call.args[0] === id)) return [made]
  for (const kid of made.kids) {
    const below = pathTo(kid, id)
    if (below.length > 0) return [made, ...below]
  }
  return []
}

const argOf = (made: Node | undefined, name: string): number | undefined => {
  const value = made?.calls.find((call) => call.name === name)?.args[0]
  return typeof value === "number" ? value : undefined
}

const has = (made: Node | undefined, name: string): boolean => made?.calls.some((call) => call.name === name) === true

test("the open Project list is placed under its selector's right edge, not by the scrolling list in the panel's bottom-left corner", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  press(agents, "filter-project")
  const element = agents.render()
  const toMenu = pathTo(element, "filter-project-menu")
  const placed = toMenu.findIndex((made) => has(made, "absolute"))
  const wrapper = toMenu[placed]
  expect(placed).toBeGreaterThan(0)
  expect(has(wrapper, "overflow_y_scrollbar")).toBe(false)
  expect(has(toMenu[placed - 1], "relative")).toBe(true)
  const toFold = pathTo(element, "fold")
  const panel = toMenu[placed - 1]
  const row = toFold.at(-2)
  const trigger = find(element, "filter-project") ?? undefined
  const panelWidth = argOf(panel, "w") ?? NaN
  const triggerRight = panelWidth - (argOf(panel, "border_r") ?? NaN) - (argOf(row, "px") ?? NaN) - (argOf(toFold.at(-1), "w") ?? NaN) - (argOf(row, "gap") ?? NaN)
  const triggerBottom = (argOf(row, "pt") ?? NaN) + (argOf(trigger, "h") ?? NaN)
  expect((argOf(wrapper, "left") ?? NaN) + (argOf(wrapper, "w") ?? NaN)).toBe(triggerRight)
  const top = argOf(wrapper, "top") ?? NaN
  expect(top).toBeGreaterThanOrEqual(triggerBottom)
  expect(top - triggerBottom).toBeLessThanOrEqual(argOf(row, "gap") ?? NaN)
  expect(has(wrapper, "bottom")).toBe(false)
  expect(has(wrapper, "right")).toBe(false)
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
