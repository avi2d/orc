import { expect, mock, test } from "bun:test"
import type { Context } from "gpui-kit"
import { buildCards, type Card } from "../../../packages/herdr-app/src/agents"
import { inboxItems } from "../../../packages/herdr-app/src/inbox"
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
const ran: Array<{ readonly name: string; readonly args: unknown }> = []
const stopped: Array<true> = []
const unused = (): never => { throw new Error("Unexpected App context call") }
const idleTask = () => ({ cancel: () => undefined, is_done: () => true })
class IdleEntity {
  set_props = unused
  release = unused
}
const cx = Object.assign(IdleEntity, {
  stop_propagation: () => { stopped.push(true) }, notify: () => undefined, spawn: idleTask,
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
    const document = documents.get(line)
    return Promise.resolve(document === undefined
      ? { code: 1, stdout: "", stderr: `Unexpected command: ${line}` }
      : { code: 0, stdout: JSON.stringify(document), stderr: "" })
  },
  settings: () => ({}), openOverlay: () => undefined, nextCommand: () => undefined, notify: () => undefined, readTextFile: () => undefined,
  run: (name: string, args: unknown) => ran.push({ name, args })
}))

test("a question on a remote run does not disappear because the Inbox reads local runs only", async () => {
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", tasks: [{
    id: "orc-60", title: "Pick a layout", kind: "ship", body: "", created: "2026-11-13T10:00:00Z",
    priority: null, dependsOn: [], prState: null, status: "new", hold: null, parked: null
  }] })
  documents.set("orc attention --json", { schema: "orc.attention.v1", items: [] })
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
  documents.set("orc runs --json", { schema: "orc.runs.v1", runs: [{ branch: "orc/orc-60", task: "orc-60", machine: "mac", questions: 1 }] })
  documents.set("orc backlog thread orc-60 --json", { schema: "orc.thread.v1", task: "orc-60", entries: [{
    at: "2026-11-13T11:00:00Z", who: "worker", kind: "question", id: "orc-60.ask-1.fixture", text: "Which layout?\nA) Wide\nB) Narrow"
  }] })
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  try {
    const reading = await readInbox()
    expect(reading).toMatchObject({ kind: "ok", value: { items: [{
      kind: "question", task: "orc-60", title: "Pick a layout", who: "worker", ask: { question: "Which layout?", options: [{ text: "Wide" }, { text: "Narrow" }] },
      action: { kind: "answer", target: { kind: "question", id: "ask-1" } }
    }] } })
  } finally {
    documents.clear()
  }
})

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

const items = inboxItems({
  backlog: [{
    id: "orc-1", title: "A task", kind: "ship", body: "", created: "2026-01-01", priority: null, dependsOn: [], prState: null,
    state: { status: "new" }, hold: null, parked: { branch: "orc/orc-1", questions: [{ id: "ask-1", text: "Which layout?", asked: null, answer: null }] }
  }],
  runs: [], attention: [],
  threads: new Map([["orc-1", { task: "orc-1", entries: [{
    kind: "question", who: "worker", id: "orc-1.ask-1.fixture", text: "Which layout?\nA) Wide\nB) Narrow", at: null
  }] }]])
})

const [card] = buildCards({ schema: "orc.runs.v1", runs: [] }, {
  schema: "orc.backlog.v1", merged: [], tasks: [
    { id: "orc-1", title: "A task", project: "orc", kind: "ship", status: "new", hold: null, parked: 1, parkedOrigin: null, reason: null }
  ]
}, items)

const queued: Card = {
  key: "orc-2", id: "orc-2", kind: "ship", delivery: null, title: "Another task", project: "orc",
  standing: { status: "Queued" }, where: "Waiting to start", runId: null, checkout: null, sendBack: null
}

test("the Awaiting you count on the Agents tab opens the Inbox as cmd-4 does instead of filtering the runs", async () => {
  const { runsColumn } = await import("../../../packages/herdr-app/src/agents-view")
  const { palette } = await import("../../../packages/herdr-app/src/palette")
  const filtered: Array<unknown> = []
  const act = {
    select: () => undefined, toggleFold: () => undefined, choose: () => undefined, setPane: () => undefined, askMerge: () => undefined,
    setFilter: (_cx: unknown, filter: unknown) => filtered.push(filter)
  }
  ran.length = 0
  stopped.length = 0
  const column: object = runsColumn(palette(), { cards: { kind: "ok", value: [card] }, filter: { project: null, status: null }, selectedKey: null, agents: new Map(), folded: false }, act)
  const count = find(column, "inbox-count")
  expect(count?.kids).toEqual(["1"])
  click(count)
  expect(ran).toEqual([cmd4])
  expect(stopped.length).toBe(1)
  expect(filtered).toEqual([])
})

const wordsOf = (element: object | string): ReadonlyArray<string> =>
  typeof element === "string" ? [element] : (nodes.get(element)?.kids ?? []).flatMap(wordsOf)

test("opening an Awaiting you card shows its open question above the steps instead of only No run yet", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const agents = new OrcAgents()
  agents.cards = { kind: "ok", value: [card, queued] }
  agents.selectedKey = queued.key
  expect(wordsOf(agents.render(cx))).not.toContain("Which layout?")
  click(find(agents.render(cx), "card-orc-1"))
  const opened = agents.render(cx)
  const steps = find(opened, "steps")
  const words = steps?.kids.flatMap(wordsOf) ?? []
  expect(words).toContain("A) Wide")
  expect(words.indexOf("Which layout?")).toBeGreaterThanOrEqual(0)
  expect(words.indexOf("Agent")).toBeGreaterThan(words.indexOf("Which layout?"))
  expect(wordsOf(opened)).not.toContain("No run yet")
})
