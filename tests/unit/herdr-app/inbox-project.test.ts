import { expect, test } from "bun:test"
import { type Node, find, nodes, press } from "./gpui-fakes"

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
