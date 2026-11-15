import { type AsyncContext, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { exec, hc, home, layout, nextCommand, props, readTextFile, run, setShared, shared } from "herdr"
import { type Guard, type Guarded, fields, guardJson, ok, string } from "../../src/guard"
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

interface Named {
  readonly address: string
  readonly name: string
  readonly state: string
}

const named: Guard<Named> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const address = string(record.value, "address", at)
  if (address.kind === "refused") return address
  const name = string(record.value, "name", at)
  if (name.kind === "refused") return name
  const state = string(record.value, "state", at)
  if (state.kind === "refused") return state
  return ok({ address: address.value, name: name.value, state: state.value })
}

const missing = (value: unknown): boolean => {
  const record = fields(value, "")
  if (record.kind === "refused") return false
  const error = fields(record.value["error"], "error")
  if (error.kind === "refused") return false
  return error.value["kind"] === "not_found"
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
    (error: unknown) => ({ kind: "refused", reason: error instanceof Error ? error.message : ["hc", args[0] ?? "", "could not start"].join(" ") })
  )

interface DrawerChat {
  readonly address: string
  readonly session: string
}

const chatKey = "orc-drawer.chat"

const drawerChat: Guard<DrawerChat> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const address = string(record.value, "address", at)
  if (address.kind === "refused") return address
  const session = string(record.value, "session", at)
  if (session.kind === "refused") return session
  return ok({ address: address.value, session: session.value })
}

const heldChat = (): DrawerChat | null => {
  const value = shared(chatKey)
  if (value === null || value === undefined) return null
  const held = drawerChat(value, chatKey)
  return held.kind === "ok" ? held.value : null
}

const chatFolder = (): string => [home(), ".orc", "chat"].join("/")

const startChat = (): Promise<Guarded<DrawerChat>> => {
  const session = [chatFolder(), ["drawer-", String(Date.now()), ".jsonl"].join("")].join("/")
  return exec("mkdir", ["-p", chatFolder()]).then(
    (made): Promise<Guarded<DrawerChat>> => made.code !== 0
      ? Promise.resolve({ kind: "refused", reason: ["Cannot make", chatFolder(), (made.stderr || made.stdout).trim()].join(" ") })
      : hcJson(["run", "--bg", "--json", "--no-parent", "--name", chatName, "--cwd", home(), "--", "orc", "chat", "--session", session], started).then((address) => {
        if (address.kind === "refused") return address
        const chat = { address: address.value, session }
        setShared(chatKey, chat)
        return ok(chat)
      }),
    (error: unknown) => ({ kind: "refused", reason: error instanceof Error ? error.message : "mkdir could not start" })
  )
}

const chatTerminal = (): Promise<Guarded<DrawerChat>> => {
  const held = heldChat()
  if (held === null) return startChat()
  return hc(["get", chatName, "--json"]).then(
    (result) => {
      if (result.code !== 0) {
        const text = (result.stderr || result.stdout).trim()
        try {
          if (missing(JSON.parse(text))) return startChat()
        } catch {
          return { kind: "refused", reason: ["hc get failed:", text].join(" ") }
        }
        return { kind: "refused", reason: ["hc get failed:", text].join(" ") }
      }
      let value: unknown
      try {
        value = JSON.parse(result.stdout)
      } catch {
        return { kind: "refused", reason: "hc get is no JSON" }
      }
      const found = named(value, "")
      if (found.kind === "refused") return missing(value) ? startChat() : found
      return found.value.address === held.address && found.value.state === "live" ? ok(held) : startChat()
    },
    (error: unknown) => ({ kind: "refused", reason: error instanceof Error ? error.message : "hc get could not start" })
  )
}

export default class OrcDrawer extends View {
  part: Part = { part: "bar" }
  problem: string | null = null
  turns: Reading<ReadonlyArray<Turn>> = { kind: "reading" }
  readText: string | null = null
  reading = false
  openThinking = new Set<string>()
  openCalls = new Set<string>()
  scroll = ScrollHandle.new()
  focusHandle: FocusHandle | null = null

  override init(_props: unknown, cx: AsyncContext): void {
    this.part = partOf(props())
    const handle = cx.focus_handle()
    this.focusHandle = handle
    if (this.part.part === "bar") {
      cx.spawn((task) => this.listen(task))
      void this.ensureChat(cx)
    }
    if (this.part.part === "turns") {
      handle.focus()
      this.readTurns(cx)
      cx.timer.every(everyMs, (tick) => this.readTurns(tick))
    }
  }

  listen(cx: AsyncContext): Promise<void> {
    return nextCommand().then(
      (command) => this.obey(cx, command),
      (error: unknown) => {
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
    return Promise.resolve()
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
      (error: unknown) => {
        this.problem = error instanceof Error ? error.message : "orc chat could not start"
        cx.notify()
      }
    )
  }

  readTurns(cx: AsyncContext): void {
    if (this.reading) return
    const chat = heldChat()
    if (chat === null) {
      this.showNoTurn(cx)
      return
    }
    this.reading = true
    cx.spawn((task) => readTextFile(chat.session).then(
      (text) => {
        this.reading = false
        if (text === null) this.showNoTurn(task)
        else this.showTurns(task, chat.session, text)
      },
      () => {
        this.reading = false
        this.readText = null
        this.turns = { kind: "failed", reason: ["Cannot read", chat.session].join(" ") }
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
    if (this.part.part === "turns") {
      const body = v_flex().size_full().bg(t.surface).child(turnsView(t, this.turns, { thinking: this.openThinking, calls: this.openCalls }, {
        toggleThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
        toggleCall: (call, cx) => this.flip(this.openCalls, call, cx)
      }, this.scroll))
      return this.hideOnEscape(body)
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
