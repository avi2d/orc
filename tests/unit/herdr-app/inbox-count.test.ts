import { expect, mock, test } from "bun:test"
import type { AsyncContext, Context } from "gpui-kit"
import fixture from "../../fixtures/attention/herdr-app.json"
import type { Card } from "../../../packages/herdr-app/src/agents"
import type { BoardTask } from "../../../packages/herdr-app/src/board"

interface Node {
  readonly calls: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }>
  readonly kids: Array<object | string>
}

const nodes = new WeakMap<object, Node>()

const isKid = (value: unknown): value is object | string => typeof value === "string" || (typeof value === "object" && value !== null)

const node = (): object => {
  const made: Node = { calls: [], kids: [] }
  const element: object = new Proxy({}, {
    get: (_target, name) => (...args: ReadonlyArray<unknown>) => {
      const kids: ReadonlyArray<unknown> = name === "child" ? [args[0]] : name === "children" && Array.isArray(args[0]) ? args[0] : []
      if (name === "child" || name === "children") made.kids.push(...kids.filter(isKid))
      else made.calls.push({ name: String(name), args })
      return element
    }
  })
  nodes.set(element, made)
  return element
}

const find = (element: object | string, id: string): Node | null => {
  const made = typeof element === "string" ? undefined : nodes.get(element)
  if (made === undefined) return null
  if (made.calls.some((call) => call.name === "id" && call.args[0] === id)) return made
  for (const kid of made.kids) {
    const found = find(kid, id)
    if (found !== null) return found
  }
  return null
}

const paths = (element: object | string, parents: ReadonlyArray<Node> = []): ReadonlyArray<ReadonlyArray<Node>> => {
  const made = typeof element === "string" ? undefined : nodes.get(element)
  if (made === undefined) return []
  const path = [...parents, made]
  return [path, ...made.kids.flatMap((kid) => paths(kid, path))]
}

const press = (view: { render(cx: Context): object }, target: string): void => {
  const rendered = paths(view.render(cx))
  const under = rendered.find((path) => path.at(-1)?.calls.some((call) => call.name === "id" && call.args[0] === target))
  if (under === undefined) throw new Error(`No element ${target}`)
  for (const path of rendered) {
    const made = path.at(-1)
    if (made !== undefined && !under.includes(made)) mouseDownOut(made)
  }
  for (const made of [...under].reverse()) mouseDown(made)
  click(find(view.render(cx), target))
}

const mouseDownOut = (made: Node): void => {
  for (const call of made.calls) {
    const handler = call.args[0]
    if (call.name === "on_mouse_down_out" && typeof handler === "function") handler({}, cx)
  }
}

const mouseDown = (made: Node): void => {
  for (const call of made.calls) {
    const handler = call.args[1]
    if (call.name === "on_mouse_down" && call.args[0] === "left" && typeof handler === "function") handler({}, cx)
  }
}

const documents = new Map<string, unknown>()
let attentionPending: Promise<{ code: number; stdout: string; stderr: string }> | null = null
const executed: Array<string> = []
const spawned: Array<Promise<unknown>> = []
const ran: Array<{ readonly name: string; readonly args: unknown }> = []
const stopped: Array<true> = []
const unused = (): never => { throw new Error("Unexpected App context call") }
const idleTask = () => ({ cancel: () => undefined, is_done: () => true })
class IdleEntity {
  set_props = unused
  release = unused
}
const cx: Context = Object.assign(IdleEntity, {
  stop_propagation: () => { stopped.push(true) }, notify: () => undefined, spawn: (body: (task: AsyncContext) => unknown) => {
    spawned.push(Promise.resolve(body(cx)))
    return idleTask()
  },
  bind_keys: unused, propagate: unused, phase: unused, theme: unused, open_url: unused,
  read_from_clipboard: unused, write_to_clipboard: unused, focus_handle: unused, sleep: unused,
  timer: { after: unused, every: unused }
}) satisfies Context

const click = (element: Node | null): void => {
  const handler = element?.calls.find((call) => call.name === "on_click")?.args[0]
  if (typeof handler === "function") handler({}, cx)
}

const listIds = new WeakMap<Node, unknown>()

const typeInto = new WeakMap<object, (text: string) => void>()

const typeIn = (box: object | undefined, text: string): void => {
  const type = box === undefined ? undefined : typeInto.get(box)
  if (type === undefined) throw new Error("No answer box")
  type(text)
}

const checkedRadio = (element: object, id: string): boolean => {
  const row = find(element, id)
  return row !== null && paths(element).some((path) => path.includes(row) && path.at(-1)?.calls.some((call) => call.name === "id" && call.args[0] === "radio-checked") === true)
}

const everyRow = (id: unknown, count: number, _key: unknown, row: (index: number, cx: Context) => object): object => {
  const element = node()
  const made = nodes.get(element)
  made?.kids.push(...Array.from({ length: count }, (_, index) => row(index, cx)))
  if (made !== undefined) listIds.set(made, id)
  return element
}

const handlersInRows = (element: object): ReadonlyArray<string> =>
  paths(element).flatMap((path) => {
    const list = path.findIndex((made) => listIds.has(made))
    const made = path.at(-1)
    return list === -1 || list === path.length - 1 || made === undefined ? [] : made.calls.filter((call) => call.name.startsWith("on_")).map((call) => call.name)
  })

const pressRow = (element: object, listId: string, key: string): void => {
  const list = paths(element).map((path) => path.at(-1)).find((made) => made !== undefined && listIds.get(made) === listId)
  const handler = list?.calls.find((call) => call.name === "on_item_click")?.args[0]
  if (typeof handler !== "function") throw new Error(`No on_item_click on ${listId}`)
  handler(key, cx)
}

void mock.module("gpui-kit", () => ({ View: Object, div: node, list: everyRow, image: node, svg: node }))
void mock.module("gpui-base", () => ({
  h_flex: node, v_flex: node, Scrollbar: { vertical: node }, Input: { new: () => node() }, TextView: { markdown: node }, Avatar: node, AvatarFallback: node, AvatarImage: node,
  ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) },
  InputState: { new: () => {
    let typed = ""
    const changed: Array<(event: object, cx: Context) => void> = []
    const on = (event: string, handler: (event: object, cx: Context) => void) => {
      if (event === "change") changed.push(handler)
    }
    const state = { value: () => typed, set_value: (text: string) => { typed = text }, on, focus: () => undefined, release: () => undefined }
    typeInto.set(state, (text) => {
      typed = text
      for (const handler of changed) handler({}, cx)
    })
    return state
  } }
}))
void mock.module("herdr", () => ({
  shared: () => null, setShared: () => undefined, layout: () => null, theme: () => ({}),
  exec: (command: string, args: ReadonlyArray<string>) => {
    const line = [command, ...args].join(" ")
    executed.push(line)
    if (line === "orc attention --json" && attentionPending !== null) return attentionPending
    const document = documents.get(line)
    return Promise.resolve(document === undefined
      ? { code: 1, stdout: "", stderr: `Unexpected command: ${line}` }
      : { code: 0, stdout: JSON.stringify(document), stderr: "" })
  },
  settings: () => ({}), openOverlay: () => undefined, nextCommand: () => undefined, notify: () => undefined, readTextFile: () => undefined,
  run: (name: string, args: unknown) => ran.push({ name, args })
}))

const openTask = (id: string) => ({
  id, title: "Update the report", project: "garden", kind: "ship", body: "", created: "2026-11-24T08:00:00Z",
  priority: null, parent: null, dependsOn: [], prState: null, status: "new", hold: null, parked: null
})

const loadAttention = async () => {
  const { readAgents } = await import("../../../packages/herdr-app/src/agents-read")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  documents.set("orc backlog --json", {
    schema: "orc.backlog.v1", tasks: fixture.items.map((item) => openTask(item.task))
  })
  documents.set("orc attention --json", fixture)
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
  const [agents, inbox] = await Promise.all([readAgents(), readInbox()])
  documents.clear()
  if (agents.kind !== "ok") throw new Error(agents.kind === "failed" ? agents.reason : agents.kind)
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  return { agents: agents.value, inbox: inbox.value }
}

test("a stalled remote question request does not hold back local steps and log refresh", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const runId = "20261126-090000-aaaaaa"
  const step = { id: 1, name: "fix", attempt: 1, status: "running", model: null, thinking: null, piSessionFile: null, from: null }
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [{ id: runId, project: "/work/garden", branch: "orc/garden-1", status: "running", prLink: null, title: "Local run", step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null }] })
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", tasks: [] })
  documents.set(`orc show ${runId} --json`, { schema: "orc.show.v1", run: { taskFile: "/work/garden/task.md" }, steps: [step] })
  documents.set(`orc log ${runId} 1`, "local output")
  let release = (): void => undefined
  attentionPending = new Promise((resolve) => { release = () => resolve({ code: 0, stdout: JSON.stringify(fixture), stderr: "" }) })
  const agents = new OrcAgents()
  try {
    agents.refresh(cx)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agents.steps?.reading.kind).toBe("ok")
    expect(agents.output.log?.reading).toEqual({ kind: "ok", value: JSON.stringify("local output") })
  } finally {
    release()
    attentionPending = null
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
  const words = wordsOf(agents.render(cx))
  expect(words).toContain("Thread")
  expect(words).toContain("The width of the herb bed")
  expect(words).toContain("Plant one row so the path to the kitchen door stays clear.")
  expect(words).toContain("Narrow")
  expect(words).not.toContain("Where should the bench go?")
  agents.selectedKey = "garden-7"
  const other = wordsOf(agents.render(cx))
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
  click(find(agents.render(cx), `option-${key}-B`))
  expect(executed).toEqual([])
  expect(agents.answers.boxes.get(key)?.value()).toBe("Narrow")
  const marked = agents.render(cx)
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
  expect(checkedRadio(agents.render(cx), `option-${key}-B`)).toBe(false)
})

test("a failed reread keeps its Could not reread card when the agents' questions arrive after it, instead of the questions clearing it", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", tasks: fixture.items.map((item) => openTask(item.task)) })
  documents.set("orc attention --json", fixture)
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
  try {
    await agents.readAll(cx)
    documents.delete("orc runs --json --local")
    await agents.readAll(cx)
    spawned.length = 0
    agents.refreshQuestions(cx)
    await Promise.all(spawned)
    const words = wordsOf(agents.render(cx))
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
  const element = agents.render(cx)
  expect(wordsOf(element)).not.toContain("Which file format should the export use?")
  expect(wordsOf(element)).not.toContain("Two retries")
  click(find(element, "toggle-agent-attention"))
  expect(wordsOf(agents.render(cx))).toContain("Which file format should the export use?")
})

test("a run row in the Runs list registers no press handler of its own, which the App refuses inside a virtual list row", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [...data.agents.cards, queued], reread: null }
  agents.agent = data.agents.agent
  click(find(agents.render(cx), "toggle-agent-attention"))
  expect(handlersInRows(agents.render(cx))).toEqual([])
  agents.folded = true
  expect(handlersInRows(agents.render(cx))).toEqual([])
})

test("pressing a run row through the list selects that run, not the run selected before", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: [...data.agents.cards, queued], reread: null }
  agents.selectedKey = "garden-8"
  pressRow(agents.render(cx), "cards", `card-${queued.key}`)
  expect(agents.selectedKey).toBe(queued.key)
  agents.folded = true
  pressRow(agents.render(cx), "rail-ids", "garden-8")
  expect(agents.selectedKey).toBe("garden-8")
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
