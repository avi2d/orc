import { expect, mock, test } from "bun:test"
import { type BoardTask, cardBox, laneJump, wheelOffset } from "../../../packages/herdr-app/src/board"

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

const called = (element: Node, name: string): boolean => element.calls.some((call) => call.name === name)
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

void mock.module("gpui-kit", () => ({ View: Object, div: node }))
void mock.module("gpui-base", () => ({ h_flex: node, v_flex: node, ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) } }))
void mock.module("herdr", () => ({ shared: () => null, setShared: () => undefined, run: () => undefined, layout: () => null, exec: () => undefined, theme: () => ({}) }))

const task = (index: number): BoardTask => ({
  id: `orc-${index}`, title: "A task", project: "orc", kind: "ship", created: `2026-01-${String(index + 1).padStart(2, "0")}`,
  status: "new", held: false, parked: false, prState: null
})

test("each open column gives its cards a scroll area that shrinks below their height while the header keeps its own", async () => {
  const { default: OrcBoard } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const board = new OrcBoard()
  board.reading = { kind: "ok", value: { backlog: { tasks: Array.from({ length: 12 }, (_, index) => task(index)), projects: [] }, attention: { items: [] } } }
  const root: object = board.render()
  const row = find(root, "lanes")
  expect(row !== null && called(row, "flex_1") && called(row, "min_h_0")).toBe(true)
  const column = find(root, "lane-Planned")
  expect(column !== null && called(column, "h_full") && called(column, "min_h_0")).toBe(true)
  const header = find(root, "toggle-Planned")
  expect(header !== null && called(header, "flex_shrink_0")).toBe(true)
  const cards = find(root, "cards-Planned")
  expect(cards === null ? [] : ["flex_1", "min_h_0", "overflow_y_scrollbar", "track_scroll"].filter((name) => !called(cards, name))).toEqual([])
  expect(cards?.kids.length).toBe(12)
})

const step = cardBox.heightPx + cardBox.gapPx
const view = { offsetPx: 0, heightPx: 2 * cardBox.padPx + 3 * cardBox.heightPx + 2 * cardBox.gapPx }
const plain = (count: number): ReadonlyArray<number> => Array.from({ length: count }, () => cardBox.heightPx)

test("the down key shows the card below the last whole card instead of moving a hidden cursor", () => {
  expect(laneJump("down", view, plain(14))).toEqual({ item: 3, offsetPx: cardBox.padPx + 3 * step + cardBox.heightPx - view.heightPx })
})

test("the up key at the top of a column stays at the top", () => {
  expect(laneJump("up", view, plain(14))).toEqual({ item: 0, offsetPx: 0 })
})

test("page down moves a whole viewport of cards and end reaches the last card", () => {
  expect(laneJump("pagedown", view, plain(14))?.item).toBe(5)
  const last = laneJump("end", view, plain(14))
  expect(last?.item).toBe(13)
  expect(last?.offsetPx).toBe(cardBox.padPx + 14 * cardBox.heightPx + 13 * cardBox.gapPx - view.heightPx)
})

test("home after scrolling returns to the first card", () => {
  expect(laneJump("home", { ...view, offsetPx: 600 }, plain(14))).toEqual({ item: 0, offsetPx: cardBox.padPx })
})

test("keys that do not scroll and empty columns give no jump", () => {
  expect(laneJump("enter", view, plain(14))).toBeNull()
  expect(laneJump("down", view, plain(0))).toBeNull()
})

test("a wheel scroll moves the tracked offset and stops at either end", () => {
  expect(wheelOffset(view, plain(14), -100)).toBe(100)
  expect(wheelOffset(view, plain(14), 100)).toBe(0)
  expect(wheelOffset(view, plain(14), -10_000)).toBe(2 * cardBox.padPx + 14 * cardBox.heightPx + 13 * cardBox.gapPx - view.heightPx)
  expect(wheelOffset(view, plain(2), -100)).toBe(0)
})

test("a taller queued card leaves room for fewer cards and pushes the end of the column down", () => {
  const heights = [cardBox.heightPx, cardBox.queuedHeightPx, ...plain(12)]
  const taller = cardBox.queuedHeightPx - cardBox.heightPx
  expect(laneJump("down", view, heights)).toEqual({ item: 2, offsetPx: cardBox.padPx + 2 * step + taller + cardBox.heightPx - view.heightPx })
  expect(wheelOffset(view, heights, -10_000)).toBe(2 * cardBox.padPx + 14 * cardBox.heightPx + taller + 13 * cardBox.gapPx - view.heightPx)
})
