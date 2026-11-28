import { mock } from "bun:test"
import type { AsyncContext, Context } from "gpui-kit"
import type { AgentsDocuments } from "../../../packages/herdr-app/src/agents-read"
import type { InboxDocuments } from "../../../packages/herdr-app/src/inbox-read"
import fixture from "../../fixtures/attention/herdr-app.json"

export interface Node {
  readonly calls: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }>
  readonly kids: Array<object | string>
}

export const nodes = new WeakMap<object, Node>()

const isKid = (value: unknown): value is object | string => typeof value === "string" || (typeof value === "object" && value !== null)

export const node = (): object => {
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

export const find = (element: object | string, id: string): Node | null => {
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

export const press = (view: { render(cx: Context): object }, target: string): void => {
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

export const documents = new Map<string, unknown>()
export const sharedValues = new Map<string, unknown>()
export const sessionFiles = new Map<string, string>()
export const stalledAttention: { pending: Promise<{ code: number; stdout: string; stderr: string }> | null } = { pending: null }
export const executed: Array<string> = []
export const spawned: Array<Promise<unknown>> = []
export const ran: Array<{ readonly name: string; readonly args: unknown }> = []
export const stopped: Array<true> = []
const unused = (): never => { throw new Error("Unexpected App context call") }
const idleTask = () => ({ cancel: () => undefined, is_done: () => true })
class IdleEntity {
  set_props = unused
  release = unused
}
export const cx: Context = Object.assign(IdleEntity, {
  stop_propagation: () => { stopped.push(true) }, notify: () => undefined, spawn: (body: (task: AsyncContext) => unknown) => {
    spawned.push(Promise.resolve(body(cx)))
    return idleTask()
  },
  bind_keys: unused, propagate: unused, phase: unused, theme: unused, open_url: unused,
  read_from_clipboard: unused, write_to_clipboard: unused, focus_handle: unused, sleep: () => Promise.resolve(),
  timer: { after: unused, every: unused }
}) satisfies Context

export const click = (element: Node | null): void => {
  const handler = element?.calls.find((call) => call.name === "on_click")?.args[0]
  if (typeof handler === "function") handler({}, cx)
}

const listIds = new WeakMap<Node, unknown>()

const typeInto = new WeakMap<object, (text: string) => void>()

export const typeIn = (box: object | undefined, text: string): void => {
  const type = box === undefined ? undefined : typeInto.get(box)
  if (type === undefined) throw new Error("No answer box")
  type(text)
}

export const checkedRadio = (element: object, id: string): boolean => {
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

const everyRange = (id: unknown, count: number, _key: unknown, rows: (range: { start: number; end: number }, cx: Context) => ReadonlyArray<object>): object => {
  const element = node()
  const made = nodes.get(element)
  made?.kids.push(...rows({ start: 0, end: count }, cx))
  if (made !== undefined) listIds.set(made, id)
  return element
}

export const handlersInRows = (element: object): ReadonlyArray<string> =>
  paths(element).flatMap((path) => {
    const list = path.findIndex((made) => listIds.has(made))
    const made = path.at(-1)
    return list === -1 || list === path.length - 1 || made === undefined ? [] : made.calls.filter((call) => call.name.startsWith("on_")).map((call) => call.name)
  })

export const pressRow = (element: object, listId: string, key: string): void => {
  const list = paths(element).map((path) => path.at(-1)).find((made) => made !== undefined && listIds.get(made) === listId)
  const handler = list?.calls.find((call) => call.name === "on_item_click")?.args[0]
  if (typeof handler !== "function") throw new Error(`No on_item_click on ${listId}`)
  handler(key, cx)
}

void mock.module("gpui-kit", () => ({ View: Object, div: node, list: everyRow, uniform_list: everyRange, image: node, svg: node }))
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

const reply = (line: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  const document = documents.get(line)
  if (document === undefined) return Promise.resolve({ code: 1, stdout: "", stderr: `Unexpected command: ${line}` })
  return Promise.resolve({ code: 0, stdout: JSON.stringify(document), stderr: "" })
}

void mock.module("herdr", () => ({
  run: (name: string, args: unknown) => ran.push({ name, args }),
  readTextFile: (file: string) => Promise.resolve(sessionFiles.get(file) ?? null),
  exec: (command: string, args: ReadonlyArray<string>) => {
    const line = [command, ...args].join(" ")
    executed.push(line)
    return line === "orc attention --json" && stalledAttention.pending !== null ? stalledAttention.pending : reply(line)
  },
  shared: (key: string) => sharedValues.get(key) ?? null, setShared: (key: string, value: unknown) => { sharedValues.set(key, value) }, layout: () => null, theme: () => ({}),
  settings: () => ({}), openOverlay: () => undefined, nextCommand: () => undefined, notify: () => undefined
}))

interface OpenTask {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly kind: string
  readonly body: string
  readonly created: string
  readonly priority: null
  readonly parent: null
  readonly dependsOn: ReadonlyArray<string>
  readonly prState: null
  readonly status: string
  readonly hold: null
  readonly parked: null
}

export const openTask = (id: string): OpenTask => ({
  id, status: "new", prState: null, hold: null, parked: null, parent: null, priority: null,
  title: "Update the report", project: "garden", kind: "ship", body: "", created: "2026-11-24T08:00:00Z", dependsOn: []
})

export const setAttentionDocuments = (): void => {
  documents.set("orc backlog --json", { schema: "orc.backlog.v1", tasks: fixture.items.map((item) => openTask(item.task)) })
  documents.set("orc attention --json", fixture)
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [] })
}

export const loadAttention = async (): Promise<{ readonly agents: AgentsDocuments; readonly inbox: InboxDocuments }> => {
  const { readAgents } = await import("../../../packages/herdr-app/src/agents-read")
  const { readInbox } = await import("../../../packages/herdr-app/src/inbox-read")
  setAttentionDocuments()
  const [agents, inbox] = await Promise.all([readAgents(), readInbox()])
  documents.clear()
  if (agents.kind !== "ok") throw new Error(agents.kind === "failed" ? agents.reason : agents.kind)
  if (inbox.kind !== "ok") throw new Error(inbox.kind === "failed" ? inbox.reason : inbox.kind)
  return { agents: agents.value, inbox: inbox.value }
}
