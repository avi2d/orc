import { expect, mock, test } from "bun:test"
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

const ran: Array<{ readonly name: string; readonly args: unknown }> = []
const stopped: Array<true> = []
const cx = { stop_propagation: () => stopped.push(true), notify: () => undefined }

const click = (element: Node | null): void => {
  const handler = element?.calls.find((call) => call.name === "on_click")?.args[0]
  if (typeof handler === "function") handler({}, cx)
}

void mock.module("gpui-kit", () => ({ View: Object, div: node }))
void mock.module("gpui-base", () => ({
  h_flex: node, v_flex: node, Input: node, Avatar: node, AvatarFallback: node, AvatarImage: node,
  ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) }
}))
void mock.module("herdr", () => ({
  shared: () => null, setShared: () => undefined, layout: () => null, exec: () => undefined, theme: () => ({}),
  settings: () => ({}), openOverlay: () => undefined, nextCommand: () => undefined, notify: () => undefined,
  run: (name: string, args: unknown) => ran.push({ name, args })
}))

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

const card: Card = {
  key: "orc-1", id: "orc-1", kind: "ship", delivery: null, title: "A task", project: "orc", known: true,
  standing: { status: "Awaiting you", waiting: { on: "answer" } }, where: "Question 1", runId: null, checkout: null, sendBack: null
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
  const column: object = runsColumn(palette(), { cards: { kind: "ok", value: [card] }, filter: { project: null, status: null, allRuns: false }, selectedKey: null, agents: new Map(), folded: false }, act)
  const count = find(column, "inbox-count")
  expect(count?.kids).toEqual(["1"])
  click(count)
  expect(ran).toEqual([cmd4])
  expect(stopped.length).toBe(1)
  expect(filtered).toEqual([])
})
