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

void mock.module("gpui-kit", () => ({ View: Object, div: node }))
void mock.module("gpui-base", () => ({
  h_flex: node, v_flex: node, Input: { new: () => node() }, TextView: { markdown: node }, Avatar: node, AvatarFallback: node, AvatarImage: node,
  ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) },
  InputState: { new: () => {
    let typed = ""
    return { value: () => typed, set_value: (text: string) => { typed = text }, on: () => undefined, focus: () => undefined, release: () => undefined }
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
  priority: null, dependsOn: [], prState: null, status: "new", hold: null, parked: null
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
  const step = { id: 1, name: "implement", attempt: 1, status: "running", model: null, thinking: null, piSessionFile: null, from: null }
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [{ id: runId, project: "/work/garden", branch: "orc/garden-1", status: "running", prLink: null, title: "Local run", step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null }] })
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", tasks: [] })
  documents.set(`orc show ${runId} --json`, { schema: "orc.show.v1", run: { taskFile: "/work/garden/task.md" }, steps: [step] })
  documents.set(`orc log ${runId} 1`, "local output")
  let release = (): void => undefined
  attentionPending = new Promise((resolve) => { release = () => resolve({ code: 0, stdout: JSON.stringify(fixture), stderr: "" }) })
  const agents = new OrcAgents()
  agents.pane = "raw"
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
  agents.menu = "project"
  press(agents, "filter-project")
  expect(agents.menu).toBeNull()
})

test("pressing the open Status trigger closes its list instead of reopening it after repaint", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.menu = "status"
  press(agents, "filter-status")
  expect(agents.menu).toBeNull()
})

test("pressing Status while Project is open switches lists instead of closing both", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.menu = "project"
  press(agents, "filter-status")
  expect(agents.menu).toEqual("status")
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
  standing: { status: "Queued" }, where: "Waiting to start", runId: null, checkout: null, sendBack: null
}

test("the Awaiting you count on the Agents tab opens the Inbox as cmd-4 does instead of filtering the runs", async () => {
  const { agents } = await loadAttention()
  const { runsColumn } = await import("../../../packages/herdr-app/src/runs-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const filtered: Array<unknown> = []
  const act = {
    select: () => undefined, toggleFold: () => undefined, choose: () => undefined, setPane: () => undefined, askMerge: () => undefined,
    openMenu: () => undefined, setFilter: (_cx: unknown, filter: unknown) => filtered.push(filter)
  }
  ran.length = 0
  stopped.length = 0
  const column: object = runsColumn(palette(), { cards: { kind: "ok", value: agents.cards }, filter: { project: null, status: null, allRuns: false }, menu: "status", selectedKey: null, agents: new Map(), folded: false }, act)
  const count = find(column, "inbox-count")
  expect(count?.kids).toEqual(["4"])
  click(count)
  expect(ran).toEqual([cmd4])
  expect(stopped.length).toBe(1)
  expect(filtered).toEqual([])
})

const wordsOf = (element: object | string): ReadonlyArray<string> =>
  typeof element === "string" ? [element] : (nodes.get(element)?.kids ?? []).flatMap(wordsOf)

test("shows the subject, outcomes, and recommendation in an unselected Agents card instead of behind the step list", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const data = await loadAttention()
  const agents = new OrcAgents()
  agents.cards = { kind: "ok", value: [...data.agents.cards, queued] }
  agents.agent = data.agents.agent
  agents.selectedKey = queued.key
  const element = agents.render(cx)
  const words = wordsOf(element)
  expect(words).toContain("The layout of the report")
  expect(words).toContain("Stack the columns so both fit on narrow screens.")
  expect(words).toContain("Narrow")
  expect(words).toContain("Overdue · Waited 1h 22m")
  expect(words).toContain("Which scope should the report cover?")
  expect(words).toContain("No options recorded")
  expect(words).not.toContain("Which file format should the export use?")
  expect(words).not.toContain("Two retries")
  click(find(element, "toggle-agent-attention"))
  expect(wordsOf(agents.render(cx))).toContain("Which file format should the export use?")
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
  expect(opened).toContain("garden-10 · Decided by the agent")
  expect(opened).toContain("Two retries")
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
    decided: fixture.decided.map((item) => ({ ...item, answer: { words: "Three retries", at: "2026-11-25T07:59:00.000Z" }, overturned: { words: "Two retries", at: "2026-11-25T07:58:00.000Z" } }))
  }
  const queue = guardJson(JSON.stringify(replaced), attention)
  if (queue.kind !== "ok") throw new Error(queue.reason)
  const view = new OrcInbox()
  view.reading = { kind: "ok", value: inboxDocuments([], queue.value) }
  const closed = wordsOf(view.render())
  expect(closed).not.toContain("garden-10 · Decided by you")
  expect(closed).not.toContain("Three retries")
  click(find(view.render(), "toggle-agent-attention"))
  const opened = wordsOf(view.render())
  expect(opened).toContain("garden-10 · Decided by the agent")
  expect(opened).toContain("Two retries")
  expect(opened).toContain("garden-10 · Decided by you")
  expect(opened).toContain("Three retries")
})
