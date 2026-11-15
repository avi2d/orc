import { type Guard, type Guarded, arrayOf, child, fields, number, ok, string } from "./guard"

interface TurnUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type CallResult =
  | { readonly kind: "running" }
  | { readonly kind: "ok"; readonly output: string }
  | { readonly kind: "failed"; readonly output: string }

export interface TurnCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
  readonly result: CallResult
}

export interface Turn {
  readonly id: string
  readonly at: number
  readonly usage: TurnUsage
  readonly thinking: string
  readonly text: string
  readonly calls: ReadonlyArray<TurnCall>
}

type Fields = Readonly<Record<string, unknown>>

type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: Fields }
  | { readonly type: "image" }

type Message =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly blocks: ReadonlyArray<Block>; readonly usage: TurnUsage; readonly at: number }
  | { readonly role: "toolResult"; readonly callId: string; readonly failed: boolean; readonly output: string }
  | { readonly role: "other" }

interface Entry {
  readonly id: string
  readonly parentId: string | null
  readonly message: Message | null
}

const refusedAs = (at: string, wanted: string, value: unknown): Guarded<never> => ({
  kind: "refused",
  reason: value === undefined ? `${at} is missing` : `${at} is ${JSON.stringify(value)}, not ${wanted}`
})

const boolean = (record: Fields, name: string, at: string): Guarded<boolean> => {
  const value = record[name]
  return typeof value === "boolean" ? ok(value) : refusedAs(child(at, name), "true or false", value)
}

const object = (record: Fields, name: string, at: string): Guarded<Fields> => fields(record[name], child(at, name))

const block: Guard<Block> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const type = string(record.value, "type", at)
  if (type.kind === "refused") return type
  switch (type.value) {
    case "text": {
      const text = string(record.value, "text", at)
      return text.kind === "refused" ? text : ok({ type: "text", text: text.value })
    }
    case "thinking": {
      const thinking = string(record.value, "thinking", at)
      return thinking.kind === "refused" ? thinking : ok({ type: "thinking", thinking: thinking.value })
    }
    case "toolCall": {
      const id = string(record.value, "id", at)
      if (id.kind === "refused") return id
      const name = string(record.value, "name", at)
      if (name.kind === "refused") return name
      const args = object(record.value, "arguments", at)
      return args.kind === "refused" ? args : ok({ type: "toolCall", id: id.value, name: name.value, arguments: args.value })
    }
    case "image":
      return ok({ type: "image" })
    default:
      return refusedAs(child(at, "type"), "text, thinking, toolCall or image", type.value)
  }
}

const textOf = (blocks: ReadonlyArray<Block>): string =>
  blocks.map((entry) => entry.type === "text" ? entry.text : entry.type === "image" ? "[image]" : "").filter((text) => text !== "").join("\n")

const usage = (record: Fields, at: string): Guarded<TurnUsage> => {
  const held = object(record, "usage", at)
  if (held.kind === "refused") return held
  const where = child(at, "usage")
  const input = number(held.value, "input", where)
  if (input.kind === "refused") return input
  const output = number(held.value, "output", where)
  if (output.kind === "refused") return output
  const cacheRead = number(held.value, "cacheRead", where)
  if (cacheRead.kind === "refused") return cacheRead
  const cacheWrite = number(held.value, "cacheWrite", where)
  if (cacheWrite.kind === "refused") return cacheWrite
  return ok({ input: input.value, output: output.value, cacheRead: cacheRead.value, cacheWrite: cacheWrite.value })
}

const userText = (record: Fields, at: string): Guarded<string> => {
  if (typeof record["content"] === "string") return ok(record["content"])
  const blocks = arrayOf(record, "content", at, block)
  return blocks.kind === "refused" ? blocks : ok(textOf(blocks.value))
}

const assistantMessage = (record: Fields, at: string): Guarded<Message> => {
  const blocks = arrayOf(record, "content", at, block)
  if (blocks.kind === "refused") return blocks
  const spent = usage(record, at)
  if (spent.kind === "refused") return spent
  const time = number(record, "timestamp", at)
  if (time.kind === "refused") return time
  return ok({ role: "assistant", blocks: blocks.value, usage: spent.value, at: time.value })
}

const toolResultMessage = (record: Fields, at: string): Guarded<Message> => {
  const callId = string(record, "toolCallId", at)
  if (callId.kind === "refused") return callId
  const failed = boolean(record, "isError", at)
  if (failed.kind === "refused") return failed
  const blocks = arrayOf(record, "content", at, block)
  if (blocks.kind === "refused") return blocks
  return ok({ role: "toolResult", callId: callId.value, failed: failed.value, output: textOf(blocks.value) })
}

const message: Guard<Message> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const role = string(record.value, "role", at)
  if (role.kind === "refused") return role
  switch (role.value) {
    case "user": {
      const text = userText(record.value, at)
      return text.kind === "refused" ? text : ok({ role: "user", text: text.value })
    }
    case "assistant":
      return assistantMessage(record.value, at)
    case "toolResult":
      return toolResultMessage(record.value, at)
    default:
      return ok({ role: "other" })
  }
}

const sessionEntry: Guard<Entry | null> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const type = string(record.value, "type", at)
  if (type.kind === "refused") return type
  if (type.value === "session") return ok(null)
  const id = string(record.value, "id", at)
  if (id.kind === "refused") return id
  const parent = record.value["parentId"]
  if (parent !== null && typeof parent !== "string") return refusedAs(child(at, "parentId"), "a string or null", parent)
  if (type.value !== "message") return ok({ id: id.value, parentId: parent, message: null })
  const said = message(record.value["message"], child(at, "message"))
  return said.kind === "refused" ? said : ok({ id: id.value, parentId: parent, message: said.value })
}

// Pi appends one line at a time, so a read can land mid-line; only newline-ended lines are whole.
const wholeLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  return lines.slice(0, -1).filter((line) => line.trim() !== "")
}

const entries = (text: string): Guarded<ReadonlyArray<Entry>> => {
  const found: Array<Entry> = []
  for (const [index, line] of wholeLines(text).entries()) {
    const at = `line ${(index + 1).toString()}`
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { kind: "refused", reason: `${at} is no JSON` }
    }
    const read = sessionEntry(value, at)
    if (read.kind === "refused") return read
    if (read.value !== null) found.push(read.value)
  }
  return ok(found)
}

// The file holds every branch of the session tree; the conversation shown is the path from the last entry to the root.
const currentBranch = (all: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
  const byId = new Map(all.map((entry) => [entry.id, entry]))
  const path: Array<Entry> = []
  const seen = new Set<string>()
  let at = all.at(-1)
  while (at !== undefined && !seen.has(at.id)) {
    seen.add(at.id)
    path.push(at)
    at = at.parentId === null ? undefined : byId.get(at.parentId)
  }
  return path.reverse()
}

const oneLine = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ") : JSON.stringify(value)

const callArguments = (args: Fields): string =>
  Object.entries(args).map(([name, value]) => `${name}=${oneLine(value)}`).join(" ")

export const sessionTurns = (text: string): Guarded<ReadonlyArray<Turn>> => {
  const read = entries(text)
  if (read.kind === "refused") return read
  const branch = currentBranch(read.value)
  const results = new Map<string, CallResult>()
  for (const entry of branch) {
    if (entry.message?.role === "toolResult") {
      const output = entry.message.output
      results.set(entry.message.callId, entry.message.failed ? { kind: "failed", output } : { kind: "ok", output })
    }
  }
  const turns: Array<Turn> = []
  for (const entry of branch) {
    const said = entry.message
    if (said?.role !== "assistant") continue
    turns.push({
      id: entry.id,
      at: said.at,
      usage: said.usage,
      thinking: said.blocks.map((part) => part.type === "thinking" ? part.thinking : "").filter((thought) => thought !== "").join("\n\n"),
      text: textOf(said.blocks.filter((part) => part.type === "text")),
      calls: said.blocks.flatMap((part) => part.type === "toolCall"
        ? [{ id: part.id, name: part.name, arguments: callArguments(part.arguments), result: results.get(part.id) ?? { kind: "running" } }]
        : [])
    })
  }
  return ok(turns)
}

const tokens = (count: number): string =>
  count < 1000 ? count.toString() : count < 1_000_000 ? `${(count / 1000).toFixed(1)}k` : `${(count / 1_000_000).toFixed(1)}M`

export const turnHeader = (turn: Turn): string =>
  [
    `in ${tokens(turn.usage.input)}`,
    `out ${tokens(turn.usage.output)}`,
    `cache read ${tokens(turn.usage.cacheRead)}`,
    `cache write ${tokens(turn.usage.cacheWrite)}`
  ].join(" · ")

const lineCount = (text: string): number => text === "" ? 0 : text.replace(/\n$/, "").split("\n").length

export const outputSize = (result: CallResult): string => {
  if (result.kind === "running") return "running"
  const lines = lineCount(result.output)
  return lines === 1 ? "1 line" : `${lines.toString()} lines`
}

export const callMark = (result: CallResult): "✓" | "✗" | "…" =>
  result.kind === "ok" ? "✓" : result.kind === "failed" ? "✗" : "…"

export const outputStart = (output: string, lines: number): string => {
  const all = output.replace(/\n$/, "").split("\n")
  return all.length <= lines ? all.join("\n") : [...all.slice(0, lines), `… ${(all.length - lines).toString()} more lines`].join("\n")
}
