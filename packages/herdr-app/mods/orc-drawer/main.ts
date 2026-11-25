import { type AsyncContext, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { closeOverlay, exec, hc, home, nextCommand, openOverlay, props, readTextFile, run, writeTextFile } from "herdr"
import { fields } from "../../src/guard"
import { DrawerController, type DrawerChat, type DrawerPane as Pane } from "../../src/drawer-controller"
import { drawerTerminal } from "../../src/drawer-terminal"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type Turn, sessionTurns } from "../../src/turns"
import { turnsView } from "../../src/turns-view"

type Role = { readonly role: "controller" } | { readonly role: "bar"; readonly view: Pane } | { readonly role: "turns"; readonly session: string }

const modName = "orc-drawer"
const overlayKey = "orc-drawer"
const everyMs = 1000
const drawerWidth = 900
const drawerHeight = 532
const barHeight = 32

const roleOf = (value: unknown): Role => {
  const record = fields(value, "")
  if (record.kind === "refused") return { role: "controller" }
  const view = record.value["view"]
  const session = record.value["session"]
  if (view === "turns" && typeof session === "string") return { role: "turns", session }
  if (view === "bar") return { role: "bar", view: record.value["shown"] === "turns" ? "turns" : "raw" }
  return { role: "controller" }
}

const drawerLayout = (view: Pane, chat: DrawerChat): unknown => ({
  type: "column",
  children: [
    { type: "block", size: { px: barHeight }, content: { mod: modName, props: { view: "bar", shown: view } } },
    { type: "block", content: view === "raw" ? { terminal: chat.address } : { mod: modName, props: { view: "turns", session: chat.session } } }
  ]
})

const stopPress = (element: Element): Element => element.on_mouse_down("left", (_event, cx) => cx.stop_propagation())

export default class OrcDrawer extends View {
  role: Role = { role: "controller" }
  controller: DrawerController | null = null
  problem: string | null = null
  turns: Reading<ReadonlyArray<Turn>> = { kind: "reading" }
  readText: string | null = null
  reading = false
  openThinking = new Set<string>()
  openCalls = new Set<string>()
  scroll = ScrollHandle.new()
  focusHandle: FocusHandle | null = null

  override init(_props: unknown, cx: AsyncContext): void {
    this.role = roleOf(props())
    this.focusHandle = cx.focus_handle()
    if (this.role.role === "controller") {
      this.controller = new DrawerController({
        ...drawerTerminal({ exec, hc, write: (path, text) => writeTextFile(path, text, null) }, home()),
        show: (view, chat) => openOverlay({ kind: "window", key: overlayKey, width: drawerWidth, height: drawerHeight, layout: drawerLayout(view, chat) }),
        hide: closeOverlay
      })
      cx.spawn((task) => this.listen(task))
    }
    if (this.role.role === "turns") {
      this.focusHandle.focus()
      this.readTurns(cx)
      cx.timer.every(everyMs, (tick) => this.readTurns(tick))
    }
  }

  listen(cx: AsyncContext): Promise<void> {
    return nextCommand().then((command) => this.controller?.obey(command).then(
      () => { this.problem = null },
      (error: unknown) => { this.problem = error instanceof Error ? error.message : "The drawer command failed" }
    )).then(() => {
      if (this.controller !== null) {
        cx.notify()
        return this.listen(cx)
      }
    })
  }

  override close(_cx: AsyncContext): void {
    if (this.controller !== null) {
      void this.controller.dispose()
      this.controller = null
    }
    if (this.role.role !== "bar") return
    const record = fields(props(), "")
    if (record.kind === "refused") return
    const overlay = record.value["overlay"]
    if (typeof overlay === "string") run([modName, ["gone", overlay].join(":")].join("."))
  }

  readTurns(cx: AsyncContext): void {
    if (this.reading || this.role.role !== "turns") return
    const { session } = this.role
    this.reading = true
    cx.spawn((task) => readTextFile(session).then(
      (text) => {
        this.reading = false
        if (text === null) this.showNoTurn(task)
        else this.showTurns(task, session, text)
      },
      () => {
        this.reading = false
        this.readText = null
        this.turns = { kind: "failed", reason: ["Cannot read", session].join(" ") }
        task.notify()
      }
    ))
  }

  showNoTurn(cx: AsyncContext): void {
    this.readText = null
    this.turns = { kind: "ok", value: [] }
    cx.notify()
  }

  showTurns(cx: AsyncContext, file: string, text: string): void {
    if (text === this.readText) return
    this.readText = text
    const shown = this.turns.kind === "ok" ? this.turns.value.length : 0
    const parsed = sessionTurns(text)
    this.turns = parsed.kind === "ok" ? { kind: "ok", value: parsed.value } : { kind: "failed", reason: [file, parsed.reason].join(": ") }
    if (parsed.kind === "ok" && parsed.value.length > shown) this.scroll.scroll_to_item(parsed.value.length - 1)
    cx.notify()
  }

  render(): Element {
    const t = palette()
    if (this.role.role === "bar") return this.closeOnEscape(this.bar(t, this.role.view))
    if (this.role.role === "turns") {
      return this.closeOnEscape(v_flex().size_full().bg(t.surface).child(turnsView(t, this.turns, { thinking: this.openThinking, calls: this.openCalls }, {
        toggleThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
        toggleCall: (call, cx) => this.flip(this.openCalls, call, cx)
      }, this.scroll, { reading: "Reading the chat's Pi session", empty: "No turn yet. Type a message in Raw and its reply shows here." })))
    }
    return this.problem === null ? div() : div().px(12).py(6).text_size(13).text_color(t.ansi1).child(this.problem)
  }

  flip(open: Set<string>, id: string, cx: Context): void {
    if (open.has(id)) open.delete(id)
    else open.add(id)
    cx.notify()
  }

  closeOnEscape(element: Element): Element {
    if (this.focusHandle === null) return element
    return element.track_focus(this.focusHandle).on_key_down((event, cx) => {
      if (event.key !== "escape") return
      run([modName, "close"].join("."))
      cx.stop_propagation()
    })
  }

  bar(t: ReturnType<typeof palette>, view: Pane): Element {
    const choice = (id: Pane, label: string): Element =>
      stopPress(div().id(["pane", id].join("-")).px(10).py(2).rounded(4).cursor_pointer()
        .bg(id === view ? t.selected : t.chrome).text_color(id === view ? t.foreground : t.muted)
        .hover((style) => style.bg(t.hover))
        .on_click(() => run([modName, ["show", id].join(":")].join(".")))
        .child(label))
    return h_flex().id("bar").size_full().px(12).gap(10).items_center().bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child("orc chat"))
      .child(h_flex().gap(2).child(choice("raw", "Raw")).child(choice("turns", "Turns")))
      .child(div().flex_1())
      .child(stopPress(div().id("close").px(6).rounded(4).cursor_pointer().text_color(t.muted)
        .hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_click(() => run([modName, "close"].join(".")))
        .child("✕")))
  }
}
