import { type AsyncContext, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { closeOverlay, exec, hc, home, nextCommand, openOverlay, props, readTextFile, run, setShared, shared } from "herdr"
import { type Guard, type Guarded, fields, guardJson, ok, string } from "../../src/guard"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type Turn, sessionTurns } from "../../src/turns"
import { turnsView } from "../../src/turns-view"

type Pane = "raw" | "turns"

type Role = { readonly role: "controller" } | { readonly role: "bar"; readonly view: Pane } | { readonly role: "turns" }

const chatName = "orc-chat"
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
  if (view === "turns") return { role: "turns" }
  if (view === "bar") return { role: "bar", view: record.value["shown"] === "turns" ? "turns" : "raw" }
  return { role: "controller" }
}

const drawerLayout = (view: Pane, chat: DrawerChat): unknown => ({
  type: "column",
  children: [
    { type: "block", size: { px: barHeight }, content: { mod: modName, props: { view: "bar", shown: view } } },
    { type: "block", content: view === "raw" ? { terminal: chat.address } : { mod: modName, props: { view: "turns" } } }
  ]
})

const stopPress = (element: Element): Element => element.on_mouse_down("left", (_event, cx) => cx.stop_propagation())

interface Named {
  readonly address: string
  readonly name: string
  readonly state: string
}

const recordWithAddress = (value: unknown, at: string): Guarded<{ record: Readonly<Record<string, unknown>>; address: string }> => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const address = string(record.value, "address", at)
  if (address.kind === "refused") return address
  return ok({ record: record.value, address: address.value })
}

const named: Guard<Named> = (value, at) => {
  const found = recordWithAddress(value, at)
  if (found.kind === "refused") return found
  const name = string(found.value.record, "name", at)
  if (name.kind === "refused") return name
  const state = string(found.value.record, "state", at)
  if (state.kind === "refused") return state
  return ok({ address: found.value.address, name: name.value, state: state.value })
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
  const found = recordWithAddress(value, at)
  if (found.kind === "refused") return found
  const session = string(found.value.record, "session", at)
  if (session.kind === "refused") return session
  return ok({ address: found.value.address, session: session.value })
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
  role: Role = { role: "controller" }
  overlay: { readonly id: string; readonly view: Pane } | null = null
  chatCheck: Promise<Guarded<DrawerChat>> | null = null
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
      cx.spawn((task) => this.listen(task))
      void this.ensureChat(cx)
    }
    if (this.role.role === "turns") {
      this.focusHandle.focus()
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
    if (command.startsWith("gone:")) {
      if (this.overlay?.id === command.slice(5)) this.overlay = null
      return Promise.resolve()
    }
    if (command === "toggle") return this.overlay === null ? this.open(cx, "raw") : Promise.resolve(this.hideDrawer())
    if (command === "show:raw") return this.open(cx, "raw")
    if (command === "show:turns") return this.open(cx, "turns")
    if (command === "close") this.hideDrawer()
    return Promise.resolve()
  }

  open(cx: AsyncContext, view: Pane): Promise<void> {
    return this.ensureChat(cx).then((chat) => {
      if (chat === null) return
      this.hideDrawer()
      const id = openOverlay({ kind: "window", key: overlayKey, width: drawerWidth, height: drawerHeight, layout: drawerLayout(view, chat) })
      this.overlay = { id, view }
      if (view === "raw") run("pane.focus", { terminal: chat.address })
    })
  }

  hideDrawer(): void {
    if (this.overlay !== null) closeOverlay(this.overlay.id)
    this.overlay = null
  }

  override close(_cx: AsyncContext): void {
    if (this.role.role !== "bar") return
    const overlay = (props() as { readonly overlay?: unknown }).overlay
    if (typeof overlay === "string") run([modName, ["gone", overlay].join(":")].join("."))
  }

  ensureChat(cx: AsyncContext): Promise<DrawerChat | null> {
    this.chatCheck ??= chatTerminal().finally(() => {
      this.chatCheck = null
    })
    return this.chatCheck.then(
      (terminal) => {
        this.problem = terminal.kind === "refused" ? terminal.reason : null
        cx.notify()
        return terminal.kind === "ok" ? terminal.value : null
      },
      (error: unknown) => {
        this.problem = error instanceof Error ? error.message : "orc chat could not start"
        cx.notify()
        return null
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
    if (this.role.role === "bar") return this.closeOnEscape(this.bar(t, this.role.view))
    if (this.role.role === "turns") {
      return this.closeOnEscape(v_flex().size_full().bg(t.surface).child(turnsView(t, this.turns, { thinking: this.openThinking, calls: this.openCalls }, {
        toggleThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
        toggleCall: (call, cx) => this.flip(this.openCalls, call, cx)
      }, this.scroll)))
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
