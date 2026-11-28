import { expect, mock, test } from "bun:test"
import type { Context } from "gpui-kit"
import fixture from "../../fixtures/attention/herdr-app.json"
import { cx } from "./gpui-fakes"

let built = 0

const node = (): object => {
  built += 1
  const element: object = new Proxy({}, { get: () => () => element })
  return element
}

interface Range {
  readonly start: number
  readonly end: number
}

type Shown =
  | { readonly kind: "list"; readonly id: unknown; readonly count: number; readonly row: (index: number, cx: Context) => unknown }
  | { readonly kind: "uniform"; readonly id: unknown; readonly count: number; readonly rows: (range: Range, cx: Context) => unknown }

const lists: Array<Shown> = []

const list = (id: unknown, count: number, _key: unknown, row: (index: number, cx: Context) => unknown): object => {
  lists.push({ kind: "list", id, count, row })
  return node()
}

const uniformList = (id: unknown, count: number, _key: unknown, rows: (range: Range, cx: Context) => unknown): object => {
  lists.push({ kind: "uniform", id, count, rows })
  return node()
}

const documents = new Map<string, unknown>()

void mock.module("gpui-kit", () => ({ View: Object, div: node, list, uniform_list: uniformList, image: node, svg: node }))
void mock.module("gpui-base", () => ({
  h_flex: node, v_flex: node, Link: { new: node }, Input: { new: node }, TextView: { markdown: node }, Avatar: node, AvatarFallback: node, AvatarImage: node,
  Scrollbar: { vertical: node }, ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) },
  InputState: { new: () => ({ value: () => "", set_value: () => undefined, on: () => undefined, focus: () => undefined, release: () => undefined }) }
}))
void mock.module("herdr", () => ({
  shared: () => null, setShared: () => undefined, layout: () => null, theme: () => ({}), settings: () => ({}),
  exec: (command: string, args: ReadonlyArray<string>) => {
    const line = [command, ...args].join(" ")
    const document = documents.get(line)
    return Promise.resolve(document === undefined
      ? { code: 1, stdout: "", stderr: `Unexpected command: ${line}` }
      : { code: 0, stdout: JSON.stringify(document), stderr: "" })
  },
  openOverlay: () => undefined, nextCommand: () => undefined, notify: () => undefined, readTextFile: () => undefined, run: () => undefined
}))

const rowsOnScreen = 12

const asked = fixture.items.find((item) => item.kind === "worker-question" && item.owner === "user")

const awaiting = (count: number): void => {
  if (asked === undefined) throw new Error("The fixture has no question the user owns")
  const tasks = Array.from({ length: count }, (_, index) => `garden-${index + 100}`)
  documents.set("orc backlog --json", {
    schema: "orc.backlog.v1",
    tasks: tasks.map((id) => ({
      id, title: "Update the report", project: "garden", kind: "ship", body: "", created: "2026-11-24T08:00:00Z",
      priority: null, parent: null, dependsOn: [], prState: null, status: "new", hold: null, parked: null
    }))
  })
  documents.set("orc attention --json", { ...fixture, items: tasks.map((task) => ({ ...asked, task, id: asked.id.replace(asked.task, task) })), decided: [] })
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
}

interface Frame {
  readonly built: number
  readonly held: ReadonlyArray<number>
  readonly rangeRows: ReadonlyMap<unknown, number>
}

const rowsReturned = (rows: unknown): number => Array.isArray(rows) ? rows.length : -1

const frame = (render: () => unknown): Frame => {
  lists.length = 0
  built = 0
  render()
  const rangeRows = new Map<unknown, number>()
  for (const shown of [...lists]) {
    const onScreen = Math.min(shown.count, rowsOnScreen)
    if (shown.kind === "uniform") rangeRows.set(shown.id, rowsReturned(shown.rows({ start: 0, end: onScreen }, cx)))
    else for (let index = 0; index < onScreen; index += 1) shown.row(index, cx)
  }
  return { built, held: lists.map((shown) => shown.count), rangeRows }
}

const agentsFrame = async (count: number, folded = false) => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const { readAgents } = await import("../../../packages/herdr-app/src/agents-read")
  awaiting(count)
  const read = await readAgents().finally(() => documents.clear())
  if (read.kind !== "ok") throw new Error(read.kind === "failed" ? read.reason : read.kind)
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: read.value.cards, reread: null }
  agents.agent = read.value.agent
  agents.folded = folded
  return frame(() => agents.render())
}

test("an Agents frame with 300 cards awaiting you builds as many elements as one with 30 instead of building every card", async () => {
  const few = await agentsFrame(30)
  const many = await agentsFrame(300)
  const statusHeader = 1
  expect(many.held).toContain(300 + statusHeader)
  expect(many.built).toBe(few.built)
})

test("an Agents frame hands its card rows to uniform_list, whose one range call returns the rows on screen instead of every row", async () => {
  const shown = await agentsFrame(300)
  const rail = await agentsFrame(300, true)
  expect(shown.rangeRows.get("cards")).toBe(rowsOnScreen)
  expect(rail.rangeRows.get("rail-ids")).toBe(rowsOnScreen)
})
