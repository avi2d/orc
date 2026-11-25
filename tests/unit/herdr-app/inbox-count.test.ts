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

const documents = new Map<string, unknown>()
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
  h_flex: node, v_flex: node, Input: node, Avatar: node, AvatarFallback: node, AvatarImage: node,
  ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) },
  InputState: { new: () => ({ value: () => "", set_value: () => undefined }) }
}))
void mock.module("herdr", () => ({
  shared: () => null, setShared: () => undefined, layout: () => null, theme: () => ({}),
  exec: (command: string, args: ReadonlyArray<string>) => {
    const line = [command, ...args].join(" ")
    executed.push(line)
    const document = documents.get(line)
    return Promise.resolve(document === undefined
      ? { code: 1, stdout: "", stderr: `Unexpected command: ${line}` }
      : { code: 0, stdout: JSON.stringify(document), stderr: "" })
  },
  settings: () => ({}), openOverlay: () => undefined, nextCommand: () => undefined, notify: () => undefined, readTextFile: () => undefined,
  run: (name: string, args: unknown) => ran.push({ name, args })
}))

const loadAttention = async () => {
  const { readAgents } = await import("../../../packages/herdr-app/src/agents-read")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  documents.set("orc backlog --json", {
    schema: "orc.backlog.v1", tasks: fixture.items.map((item) => ({
      id: item.task, title: "Update the report", project: "garden", kind: "ship", body: "", created: "2026-11-24T08:00:00Z",
      priority: null, dependsOn: [], prState: null, status: "new", hold: null, parked: null
    }))
  })
  documents.set("orc attention --json", fixture)
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
  const [agents, inbox] = await Promise.all([readAgents(), readInbox()])
  documents.clear()
  if (agents.kind !== "ok") throw new Error(agents.kind === "failed" ? agents.reason : agents.kind)
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  return { agents: agents.value, inbox: inbox.value }
}

const cmd4 = { name: "layout.select", args: { stack: "orc-views", child: "orc-inbox" } }

const task: BoardTask = {
  id: "orc-1", title: "A task", project: "orc", kind: "ship", created: "2026-01-01", status: "new", held: true, parked: false, prState: null
}

test("the Awaiting you lane count on the Board opens the Inbox as cmd-4 does instead of folding the lane", async () => {
  const { default: OrcBoard } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const board = new OrcBoard()
  board.reading = { kind: "ok", value: { backlog: { tasks: [task], projects: [] }, attention: { items: [] } } }
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
