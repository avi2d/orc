import { expect, mock, test } from "bun:test"
import type { AsyncContext, Context } from "gpui-kit"
import fixture from "../../fixtures/attention/herdr-app.json"

let built = 0

const node = (): object => {
  built += 1
  const element: object = new Proxy({}, { get: () => () => element })
  return element
}

interface Shown {
  readonly id: unknown
  readonly count: number
  readonly row: (index: number, cx: Context) => unknown
}

const lists: Array<Shown> = []

const list = (id: unknown, count: number, _key: unknown, row: Shown["row"]): object => {
  lists.push({ id, count, row })
  return node()
}

const unused = (): never => { throw new Error("Unexpected App context call") }
class IdleEntity {
  set_props = unused
  release = unused
}
const cx: Context = Object.assign(IdleEntity, {
  stop_propagation: unused, notify: () => undefined, spawn: (body: (task: AsyncContext) => unknown) => {
    void body(cx)
    return { cancel: () => undefined, is_done: () => true }
  },
  bind_keys: unused, propagate: unused, phase: unused, theme: unused, open_url: unused,
  read_from_clipboard: unused, write_to_clipboard: unused, focus_handle: unused, sleep: unused,
  timer: { after: unused, every: unused }
}) satisfies Context

const documents = new Map<string, unknown>()

void mock.module("gpui-kit", () => ({ View: Object, div: node, list, image: node, svg: node }))
void mock.module("gpui-base", () => ({
  h_flex: node, v_flex: node, Input: { new: node }, TextView: { markdown: node }, Avatar: node, AvatarFallback: node, AvatarImage: node,
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

const frame = (render: () => unknown): { readonly built: number; readonly held: ReadonlyArray<number> } => {
  lists.length = 0
  built = 0
  render()
  for (const shown of [...lists]) {
    for (let index = 0; index < Math.min(shown.count, rowsOnScreen); index += 1) shown.row(index, cx)
  }
  return { built, held: lists.map((shown) => shown.count) }
}

const agentsFrame = async (count: number) => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const { readAgents } = await import("../../../packages/herdr-app/src/agents-read")
  awaiting(count)
  const read = await readAgents().finally(() => documents.clear())
  if (read.kind !== "ok") throw new Error(read.kind === "failed" ? read.reason : read.kind)
  const agents = new OrcAgents()
  agents.list = { kind: "ok", cards: read.value.cards, reread: null }
  agents.agent = read.value.agent
  return frame(() => agents.render(cx))
}

const inboxFrame = async (count: number) => {
  const { default: OrcInbox } = await import("../../../packages/herdr-app/mods/orc-inbox/main")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  awaiting(count)
  const view = new OrcInbox()
  view.reading = await readInbox().finally(() => documents.clear())
  if (view.reading.kind === "ok") view.answers.sync(cx, view.reading.value.items)
  return frame(() => view.render())
}

test("an Agents frame with 300 cards awaiting you builds as many elements as one with 30 instead of building every card", async () => {
  const few = await agentsFrame(30)
  const many = await agentsFrame(300)
  expect(many.held).toContain(300)
  expect(many.built).toBe(few.built)
})

test("an Inbox frame with 300 questions builds as many elements as one with 30 instead of building every question", async () => {
  const few = await inboxFrame(30)
  const many = await inboxFrame(300)
  expect(many.held).toContain(300)
  expect(many.built).toBe(few.built)
})
