import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { closeOverlay, exec, hc, home, nextCommand, openOverlay, props, readTextFile, run, setShared, shared } from "herdr"
import { type Guard, type Guarded, arrayOf, fields, guardJson, ok, string } from "../../src/guard"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type Turn, sessionTurns } from "../../src/turns"
import { turnsView } from "../../src/turns-view"

type Pane = "raw" | "turns"

type Part =
  | { readonly part: "handle" }
  | { readonly part: "bar"; readonly pane: Pane }
  | { readonly part: "turns" }

const modName = "orc-drawer"
const chatName = "orc-chat"
const everyMs = 1000
const windowKey = "orc-drawer.window"

// Set and cleared by the bar copy inside the window, so a close by Esc, overlay.close or a layout switch clears it too.
const openWindow = (): string | null => {
  const id = shared(windowKey)
  return typeof id === "string" ? id : null
}

const ownWindow = (): string | null => {
  const given = fields(props(), "props")
  if (given.kind === "refused") return null
  const overlay = string(given.value, "overlay", "props")
  return overlay.kind === "refused" ? null : overlay.value
}

const sessionsDir = (): string => `${home()}/.pi/agent/sessions/--orc-drawer--`

const partOf = (value: unknown): Part => {
  const record = fields(value, "")
  if (record.kind === "refused") return { part: "handle" }
  const part = record.value["part"]
  if (part === "turns") return { part: "turns" }
  if (part === "bar") return { part: "bar", pane: record.value["pane"] === "turns" ? "turns" : "raw" }
  return { part: "handle" }
}

const stopPress = (element: Element): Element => element.on_mouse_down("left", (_event, cx) => cx.stop_propagation())

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
  hc([...args]).then((result) => result.code === 0
    ? guardJson(result.stdout, guard)
    : { kind: "refused", reason: `hc ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).trim()}` })

const startChat = (): Promise<Guarded<string>> =>
  exec("mkdir", ["-p", sessionsDir()]).then((made) => made.code === 0
    ? hcJson(
      ["run", "--bg", "--json", "--no-parent", "--name", chatName, "--cwd", home(), "--", "env", `PI_CODING_AGENT_SESSION_DIR=${sessionsDir()}`, "orc", "chat"],
      started
    )
    : { kind: "refused", reason: `Cannot create ${sessionsDir()}: ${made.stderr.trim()}` })

// A live chat is reused by name, so reopening the drawer shows the same conversation.
const chatTerminal = (): Promise<Guarded<string>> =>
  hcJson(["ls", "--json"], terminalList).then((terminals) => {
    if (terminals.kind === "refused") return terminals
    const live = terminals.value.find((terminal) => terminal.name === chatName && terminal.state === "live")
    return live === undefined ? startChat() : ok(live.address)
  })

const drawerLayout = (pane: Pane, terminal: string): unknown => ({
  type: "column",
  children: [
    { type: "block", size: { px: 40 }, content: { mod: modName, props: { part: "bar", pane } } },
    { type: "block", content: pane === "raw" ? { terminal } : { mod: modName, props: { part: "turns" } } }
  ]
})

const newestSession = (): Promise<string | null> =>
  exec("ls", ["-t", sessionsDir()]).then((listing) => {
    if (listing.code !== 0) return null
    const newest = listing.stdout.split("\n").find((name) => name.endsWith(".jsonl"))
    return newest === undefined ? null : `${sessionsDir()}/${newest}`
  })

export default class OrcDrawer extends View {
  part: Part = { part: "handle" }
  pane: Pane = "raw"
  problem: string | null = null
  turns: Reading<ReadonlyArray<Turn>> = { kind: "reading" }
  readText: string | null = null
  openThinking = new Set<string>()
  openCalls = new Set<string>()
  scroll = ScrollHandle.new()

  override init(_props: unknown, cx: AsyncContext): void {
    this.part = partOf(props())
    if (this.part.part === "handle") {
      cx.spawn((task) => this.listen(task))
    }
    if (this.part.part === "bar") setShared(windowKey, ownWindow())
    if (this.part.part === "turns") {
      this.readTurns(cx)
      cx.timer.every(everyMs, (tick) => this.readTurns(tick))
    }
  }

  listen(cx: AsyncContext): Promise<void> {
    return nextCommand().then((command) => this.obey(cx, command)).then(() => {
      cx.notify()
      return this.listen(cx)
    })
  }

  obey(cx: AsyncContext, command: string): Promise<void> {
    if (command === "toggle" && openWindow() === null) return this.open(cx, this.pane)
    if (command === "toggle" || command === "close") this.closeWindow()
    if (command === "show:raw") return this.open(cx, "raw")
    if (command === "show:turns") return this.open(cx, "turns")
    return Promise.resolve()
  }

  open(cx: AsyncContext, pane: Pane): Promise<void> {
    return chatTerminal().then((terminal) => {
      if (terminal.kind === "refused") {
        this.problem = terminal.reason
        return
      }
      this.problem = null
      this.pane = pane
      const show = (): void => {
        openOverlay({ kind: "window", key: modName, width: 0.8, height: 0.8, layout: drawerLayout(pane, terminal.value) })
      }
      if (openWindow() === null) return show()
      // Opening the key of an open window closes it rather than replacing it, and a close and an open in one frame close both.
      this.closeWindow()
      return cx.sleep(50).then(show)
    })
  }

  closeWindow(): void {
    const id = openWindow()
    if (id !== null) closeOverlay(id)
  }

  override close(): void {
    if (this.part.part === "bar" && openWindow() === ownWindow()) setShared(windowKey, null)
  }

  readTurns(cx: AsyncContext): void {
    cx.spawn((task) => newestSession().then((file) => {
      if (file === null) {
        this.turns = { kind: "ok", value: [] }
        task.notify()
        return
      }
      return readTextFile(file).then((text) => this.showTurns(task, file, text))
    }))
  }

  showTurns(cx: AsyncContext, file: string, text: string | null): void {
    if (text === null || text === this.readText) return
    this.readText = text
    const shown = this.turns.kind === "ok" ? this.turns.value.length : 0
    const parsed = sessionTurns(text)
    this.turns = parsed.kind === "ok" ? { kind: "ok", value: parsed.value } : { kind: "failed", reason: `${file}: ${parsed.reason}` }
    if (parsed.kind === "ok" && parsed.value.length > shown) this.scroll.scroll_to_item(parsed.value.length - 1)
    cx.notify()
  }

  render(): Element {
    const t = palette()
    switch (this.part.part) {
      case "handle":
        return this.handle(t)
      case "bar":
        return this.bar(t, this.part.pane)
      case "turns":
        return v_flex().size_full().bg(t.surface).child(turnsView(t, this.turns, { thinking: this.openThinking, calls: this.openCalls }, {
          toggleThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
          toggleCall: (call, cx) => this.flip(this.openCalls, call, cx)
        }, this.scroll))
    }
  }

  flip(open: Set<string>, id: string, cx: Context): void {
    if (open.has(id)) open.delete(id)
    else open.add(id)
    cx.notify()
  }

  handle(t: ReturnType<typeof palette>): Element {
    return h_flex().id("handle").gap(6).px(10).h(22).items_center().cursor_pointer().text_size(12)
      .text_color(this.problem === null ? t.muted : t.blocked)
      .hover((style) => style.text_color(t.foreground))
      .on_click(() => run(`${modName}.toggle`))
      .child(this.problem ?? "Chat")
      .child(div().text_color(t.dim).child("⌘K"))
  }

  bar(t: ReturnType<typeof palette>, pane: Pane): Element {
    const choice = (id: Pane, label: string): Element =>
      stopPress(div().id(`pane-${id}`).px(10).py(2).rounded(4).cursor_pointer()
        .bg(id === pane ? t.selected : t.chrome).text_color(id === pane ? t.foreground : t.muted)
        .hover((style) => style.bg(t.hover))
        .on_click(() => run(`${modName}.show:${id}`))
        .child(label))
    return h_flex().id("bar").size_full().px(12).gap(10).items_center().bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child("orc chat"))
      .child(h_flex().gap(2).child(choice("raw", "Raw")).child(choice("turns", "Turns")))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child("⌘K closes"))
      .child(stopPress(div().id("close").px(6).rounded(4).cursor_pointer().text_color(t.muted)
        .hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_click(() => run(`${modName}.close`))
        .child("✕")))
  }
}
