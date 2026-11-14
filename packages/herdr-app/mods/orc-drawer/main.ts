import { type AsyncContext, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { exec, hc, home, layout, nextCommand, props, readTextFile, run } from "herdr"
import { type Guard, type Guarded, arrayOf, fields, guardJson, ok, string } from "../../src/guard"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type Turn, sessionTurns } from "../../src/turns"
import { turnsView } from "../../src/turns-view"
import { activeChild } from "../../src/views"

type Part = { readonly part: "bar" } | { readonly part: "turns" }

const modName = "orc-drawer"
const chatName = "orc-chat"
const drawerId = "orc-drawer"
const viewsId = "orc-drawer-views"
const rawId = "orc-drawer-raw"
const turnsId = "orc-drawer-turns"
const everyMs = 1000

const partOf = (value: unknown): Part => {
  const record = fields(value, "")
  if (record.kind === "refused") return { part: "bar" }
  return record.value["view"] === "turns" ? { part: "turns" } : { part: "bar" }
}

const stopPress = (element: Element): Element => element.on_mouse_down("left", (_event, cx) => cx.stop_propagation())

const activePane = (): string => activeChild(layout(), viewsId) === turnsId ? "turns" : "raw"

interface Listed {
  readonly address: string
  readonly name: string | null
  readonly state: string
}

const listed: Guard<Listed> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const address = string(record.value, "address", at)
  if (address.kind === "refused") return address
  const state = string(record.value, "state", at)
  if (state.kind === "refused") return state
  const name = record.value["name"] === undefined ? ok(null) : string(record.value, "name", at)
  if (name.kind === "refused") return name
  return ok({ address: address.value, name: name.value, state: state.value })
}

const terminalList: Guard<ReadonlyArray<Listed>> = (value, at) => {
  const record = fields(value, at)
  return record.kind === "refused" ? record : arrayOf(record.value, "terminals", at, listed)
}

const started: Guard<string> = (value, at) => {
  const record = fields(value, at)
  return record.kind === "refused" ? record : string(record.value, "address", at)
}

const hcJson = <A>(args: ReadonlyArray<string>, guard: Guard<A>): Promise<Guarded<A>> =>
  hc([...args]).then(
    (result) => result.code === 0
      ? guardJson(result.stdout, guard)
      : { kind: "refused", reason: ["hc", args[0] ?? "", "failed:", (result.stderr || result.stdout).trim()].join(" ") },
    (error) => ({ kind: "refused", reason: error instanceof Error ? error.message : ["hc", args[0] ?? "", "could not start"].join(" ") })
  )

const startChat = (): Promise<Guarded<string>> =>
  hcJson(["run", "--bg", "--json", "--no-parent", "--name", chatName, "--cwd", home(), "--", "orc", "chat"], started)

const chatTerminal = (): Promise<Guarded<string>> =>
  hcJson(["ls", "--json"], terminalList).then((terminals) => {
    if (terminals.kind === "refused") return terminals
    const live = terminals.value.find((terminal) => terminal.name === chatName && terminal.state === "live")
    return live === undefined ? startChat() : ok(live.address)
  })

interface AgentSession {
  readonly kind: string
  readonly value: string
}

interface AgentEntry {
  readonly address: string | null
  readonly terminal: string | null
  readonly name: string | null
  readonly session: AgentSession | null
}

const textField = (record: Record<string, unknown>, name: string): string | null => {
  const value = record[name]
  return typeof value === "string" ? value : null
}

const agentEntry: Guard<AgentEntry> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const held = record.value
  const sessionValue = held["agent_session"]
  if (sessionValue !== undefined && sessionValue !== null) {
    const sessionRecord = fields(sessionValue, at)
    if (sessionRecord.kind === "refused") return sessionRecord
    const kind = string(sessionRecord.value, "kind", at)
    if (kind.kind === "refused") return kind
    const sessionPath = string(sessionRecord.value, "value", at)
    if (sessionPath.kind === "refused") return sessionPath
    return ok({
      address: textField(held, "address") ?? textField(held, "terminal") ?? textField(held, "pane_id"),
      terminal: textField(held, "terminal"),
      name: textField(held, "name"),
      session: { kind: kind.value, value: sessionPath.value }
    })
  }
  return ok({
    address: textField(held, "address") ?? textField(held, "terminal") ?? textField(held, "pane_id"),
    terminal: textField(held, "terminal"),
    name: textField(held, "name"),
    session: null
  })
}

const agentList: Guard<ReadonlyArray<AgentEntry>> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const result = fields(record.value["result"], at)
  if (result.kind === "refused") return result
  return arrayOf(result.value, "agents", at, agentEntry)
}

const sessionFor = (agents: ReadonlyArray<AgentEntry>, address: string): string | null => {
  const direct = agents.find((agent) => agent.session !== null && agent.session.kind === "path" && (agent.address === address || agent.terminal === address))
  if (direct !== undefined && direct.session !== null) return direct.session.value
  const named = agents.find((agent) => agent.session !== null && agent.session.kind === "path" && agent.name === chatName)
  return named !== undefined && named.session !== null ? named.session.value : null
}

const agentSessionPath = (address: string): Promise<Guarded<string | null>> =>
  exec("herdr", ["agent", "list"]).then(
    (result) => {
      if (result.code !== 0) return { kind: "refused", reason: ["herdr agent list failed:", (result.stderr || result.stdout).trim()].join(" ") }
      const parsed = guardJson(result.stdout, agentList)
      if (parsed.kind === "refused") return parsed
      return ok(sessionFor(parsed.value, address))
    },
    (error) => ({ kind: "refused", reason: error instanceof Error ? error.message : "herdr agent list could not start" })
  )

const drawerSession = (): Promise<Guarded<string | null>> =>
  chatTerminal().then((terminal) => {
    if (terminal.kind === "refused") return terminal
    return agentSessionPath(terminal.value)
  })

export default class OrcDrawer extends View {
  part: Part = { part: "bar" }
  problem: string | null = null
  turns: Reading<ReadonlyArray<Turn>> = { kind: "reading" }
  readText: string | null = null
  openThinking = new Set<string>()
  openCalls = new Set<string>()
  scroll = ScrollHandle.new()
  focusHandle: FocusHandle | null = null

  override init(_props: unknown, cx: AsyncContext): void {
    this.part = partOf(props())
    this.focusHandle = cx.focus_handle()
    if (this.part.part === "bar") {
      cx.spawn((task) => this.listen(task))
    }
    if (this.part.part === "turns") {
      if (this.focusHandle !== null) this.focusHandle.focus()
      this.readTurns(cx)
      cx.timer.every(everyMs, (tick) => this.readTurns(tick))
    }
  }

  listen(cx: AsyncContext): Promise<void> {
    return nextCommand().then(
      (command) => this.obey(cx, command),
      (error) => {
        this.problem = error instanceof Error ? error.message : "The drawer command failed"
      }
    ).then(
      () => {
        cx.notify()
        return this.listen(cx)
      },
      () => {
        cx.notify()
        return this.listen(cx)
      }
    )
  }

  obey(cx: AsyncContext, command: string): Promise<void> {
    if (command === "close") {
      run("layout.hide", { id: drawerId })
      return Promise.resolve()
    }
    if (command === "show:raw" || command === "show:turns") {
      const child = command === "show:raw" ? rawId : turnsId
      return this.ensureChat(cx).then(() => {
        run("layout.show", { id: drawerId })
        run("layout.select", { stack: viewsId, child })
      })
    }
    return this.ensureChat(cx).then(() => {
      run("layout.toggle", { id: drawerId })
    })
  }

  ensureChat(cx: AsyncContext): Promise<void> {
    return chatTerminal().then(
      (terminal) => {
        if (terminal.kind === "refused") {
          this.problem = terminal.reason
        } else {
          this.problem = null
        }
        cx.notify()
      },
      (error) => {
        this.problem = error instanceof Error ? error.message : "orc chat could not start"
        cx.notify()
      }
    )
  }

  readTurns(cx: AsyncContext): void {
    cx.spawn((task) => drawerSession().then(
      (session) => {
        if (session.kind === "refused") {
          this.turns = { kind: "failed", reason: session.reason }
          task.notify()
          return
        }
        if (session.value === null) {
          this.turns = { kind: "ok", value: [] }
          task.notify()
          return
        }
        const file = session.value
        return readTextFile(file).then(
          (text) => this.showTurns(task, file, text),
          () => {
            this.turns = { kind: "failed", reason: ["Cannot read", file].join(" ") }
            task.notify()
          }
        )
      },
      () => {
        this.turns = { kind: "failed", reason: "herdr agent list could not start" }
        task.notify()
      }
    ))
  }

  showTurns(cx: AsyncContext, file: string, text: string | null): void {
    if (text === null || text === this.readText) return
    this.readText = text
    const shown = this.turns.kind === "ok" ? this.turns.value.length : 0
    const parsed = sessionTurns(text)
    this.turns = parsed.kind === "ok" ? { kind: "ok", value: parsed.value } : { kind: "failed", reason: [file, parsed.reason].join(": ") }
    if (parsed.kind === "ok" && parsed.value.length > shown) this.scroll.scroll_to_item(parsed.value.length - 1)
    cx.notify()
  }

  render(): Element {
    const t = palette()
    if (this.part.part === "turns") {
      const body = v_flex().size_full().bg(t.surface).child(turnsView(t, this.turns, { thinking: this.openThinking, calls: this.openCalls }, {
        toggleThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
        toggleCall: (call, cx) => this.flip(this.openCalls, call, cx)
      }, this.scroll))
      if (this.focusHandle === null) return body
      const handle = this.focusHandle
      return body.track_focus(handle).on_key_down((event, cx) => {
        if (event.key !== "escape") return
        run("layout.hide", { id: drawerId })
        cx.stop_propagation()
      })
    }
    return this.bar(t)
  }

  flip(open: Set<string>, id: string, cx: Context): void {
    if (open.has(id)) open.delete(id)
    else open.add(id)
    cx.notify()
  }

  hideOnEscape(element: Element): Element {
    if (this.focusHandle === null) return element
    const handle = this.focusHandle
    return element.track_focus(handle).on_key_down((event, cx) => {
      if (event.key !== "escape") return
      run("layout.hide", { id: drawerId })
      cx.stop_propagation()
    })
  }

  bar(t: ReturnType<typeof palette>): Element {
    const pane = activePane()
    const choice = (id: string, label: string, command: string): Element =>
      stopPress(div().id(["pane", id].join("-")).px(10).py(2).rounded(4).cursor_pointer()
        .bg(id === pane ? t.selected : t.chrome).text_color(id === pane ? t.foreground : t.muted)
        .hover((style) => style.bg(t.hover))
        .on_click(() => run([modName, command].join(".")))
        .child(label))
    const root = h_flex().id("bar").size_full().px(12).gap(10).items_center().bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child(this.problem ?? "orc chat"))
      .child(h_flex().gap(2).child(choice("raw", "Raw", "show:raw")).child(choice("turns", "Turns", "show:turns")))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child("Esc closes"))
      .child(stopPress(div().id("close").px(6).rounded(4).cursor_pointer().text_color(t.muted)
        .hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_click(() => run([modName, "close"].join(".")))
        .child("✕")))
    return this.hideOnEscape(root)
  }
}
