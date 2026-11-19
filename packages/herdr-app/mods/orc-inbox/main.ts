import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { Avatar, AvatarFallback, AvatarImage, Input, InputState, h_flex, v_flex } from "gpui-base"
import { exec, nextCommand, openOverlay } from "herdr"
import { askingRuns, attention } from "../../src/guard"
import { type InboxItem, inboxItems, inboxTasks } from "../../src/inbox"
import { linkedText } from "../../src/links-view"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type AnswerTarget, answerArgv, mergeArgv, shortTime } from "../../src/task"
import { taskDetails, thread } from "../../src/task-guard"
import { type AskOption, type Thread, optionShape, whoLabel } from "../../src/thread"
import { refreshWhenShown } from "../../src/views"

type Palette = ReturnType<typeof palette>

interface InboxDocuments {
  readonly items: ReadonlyArray<InboxItem>
  readonly unread: ReadonlyArray<string>
}

type Sent = { readonly kind: "sending" } | { readonly kind: "failed"; readonly reason: string }

const kindLabels: Readonly<Record<InboxItem["kind"], string>> = { question: "Question", decision: "Decision", hold: "Hold", pr: "PR" }

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

const answerTarget = (item: InboxItem): AnswerTarget | null =>
  item.action?.kind === "answer" ? item.action.target : null

export default class OrcInbox extends View {
  reading: Reading<InboxDocuments> = { kind: "reading" }
  visible = false
  lastRead = 0
  busy = false
  stale = false
  boxes = new Map<string, InputState>()
  sent = new Map<string, Sent>()
  merging: string | null = null

  load = (): Promise<Reading<InboxDocuments>> =>
    Promise.all([
      readJson("orc", ["backlog", "--json"], taskDetails),
      readJson("orc", ["attention", "--json"], attention),
      readJson("orc", ["runs", "--json"], askingRuns)
    ]).then(([backlog, asked, runs]): Reading<InboxDocuments> | Promise<Reading<InboxDocuments>> => {
      if (backlog.kind !== "ok") return backlog
      if (asked.kind !== "ok") return asked
      if (runs.kind !== "ok") return runs
      const sources = { backlog: backlog.value, attention: asked.value, runs: runs.value }
      return Promise.all(inboxTasks(sources).map((id) => readJson("orc", ["backlog", "thread", id, "--json"], thread))).then((told) => {
        const threads = new Map<string, Thread>(told.flatMap((reading) => reading.kind === "ok" ? [[reading.value.task, reading.value] as const] : []))
        const unread = told.flatMap((reading) => reading.kind === "failed" ? [reading.reason] : [])
        return { kind: "ok", value: { items: inboxItems({ ...sources, threads }), unread } }
      })
    })

  override init(_props: unknown, cx: AsyncContext): void {
    refreshWhenShown("orc-inbox", 10_000, cx, this)
    cx.timer.every(150, (tick) => this.syncBoxes(tick))
    cx.spawn((task) => this.listen(task))
  }

  listen(cx: AsyncContext): Promise<void> {
    return nextCommand().then((command) => {
      if (command === "merge") this.merge(cx)
      return this.listen(cx)
    })
  }

  reload(cx: Context): void {
    if (this.busy) {
      this.stale = true
      return
    }
    this.busy = true
    cx.spawn((task) => this.load().then((reading) => {
      this.reading = reading
      this.busy = false
      if (this.stale) {
        this.stale = false
        this.reload(task)
      }
      task.notify()
    }))
  }

  orc(cx: Context, key: string, argv: ReadonlyArray<string>, done: () => void): void {
    this.sent.set(key, { kind: "sending" })
    cx.spawn((task) => exec("orc", [...argv]).then(
      (result) => {
        if (result.code === 0) {
          this.sent.delete(key)
          done()
        } else {
          this.sent.set(key, { kind: "failed", reason: `orc ${argv.join(" ")} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}` })
        }
        this.reload(task)
        task.notify()
      },
      () => {
        this.sent.set(key, { kind: "failed", reason: "Could not start orc. Check that it is on PATH." })
        task.notify()
      }
    ))
    cx.notify()
  }

  answer(cx: Context, item: InboxItem, target: AnswerTarget, words: string, done: () => void): void {
    if (this.sent.get(item.key)?.kind === "sending") return
    const argv = answerArgv(item.task, target, words)
    if (argv !== null) this.orc(cx, item.key, argv, done)
  }

  answerFromBox(cx: Context, item: InboxItem, target: AnswerTarget): void {
    const box = this.boxes.get(item.key)
    if (box !== undefined) this.answer(cx, item, target, box.value(), () => box.set_value(""))
  }

  askMerge(item: InboxItem): void {
    this.merging = item.task
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      width: 420,
      height: 180,
      props: { title: `Merge the PR of ${item.task}?`, detail: `orc ${mergeArgv(item.task).join(" ")}`, command: { name: "orc-inbox.merge" } }
    })
  }

  merge(cx: Context): void {
    const task = this.merging
    this.merging = null
    if (task !== null) this.orc(cx, `${task}/pr`, mergeArgv(task), () => undefined)
  }

  // InputState.new refuses to run during render, so boxes are made here on a timer tick.
  syncBoxes(cx: AsyncContext): void {
    if (this.reading.kind !== "ok") return
    const items = this.reading.value.items
    const wanted = new Set(items.flatMap((item) => answerTarget(item) === null ? [] : [item.key]))
    let changed = false
    for (const [key, box] of this.boxes) {
      if (wanted.has(key)) continue
      box.release()
      this.boxes.delete(key)
      changed = true
    }
    for (const item of items) {
      const target = answerTarget(item)
      if (target === null || this.boxes.has(item.key)) continue
      const box = InputState.new({ placeholder: target.kind === "hold" ? "Answer the hold" : `Answer ${target.id}` })
      box.on("submit", (_event, submitCx) => this.answerFromBox(submitCx, item, target))
      this.boxes.set(item.key, box)
      changed = true
    }
    if (changed) cx.notify()
  }

  render(): Element {
    const t = palette()
    const root = v_flex().id("root").size_full().min_w_0().bg(t.background).text_size(13).text_color(t.foreground)
    if (this.reading.kind === "failed") return root.child(div().p(16).text_color(t.blocked).child(this.reading.reason))
    if (this.reading.kind === "reading") return root.child(div().p(16).text_color(t.muted).child("Reading the inbox"))
    const { items, unread } = this.reading.value
    const body = v_flex().id("items").flex_1().min_h_0().overflow_y_scrollbar().p(16).gap(12)
      .children(unread.map((reason) => div().text_color(t.blocked).child(reason)))
    return root.child(items.length === 0
      ? body.child(div().text_color(t.muted).child("No task awaits you"))
      : body.children(items.map((item) => this.item(t, item))))
  }

  item(t: Palette, item: InboxItem): Element {
    const asked = h_flex().gap(6).text_size(12)
      .child(div().font_semibold().child(whoLabel(item)))
      .child(div().text_color(t.dim).child("·"))
      .child(div().text_color(t.muted).child(kindLabels[item.kind]))
      .children(item.asked === null ? [] : [div().text_color(t.dim).child("·"), div().text_color(t.dim).child(shortTime(item.asked))])
    const ask = item.ask
    return v_flex().id(`item-${item.key}`).gap(6).p(10).rounded(6).bg(t.raised)
      .child(h_flex().gap(8).child(div().font_semibold().child(item.task)).child(div().min_w_0().text_color(t.muted).child(item.title)))
      .child(asked)
      .children(ask.context === null ? [] : [this.section(t, "Context", linkedText(`context-${item.key}`, ask.context))])
      .child(this.section(t, "Question", linkedText(`question-${item.key}`, ask.question)))
      .children(ask.options.length === 0 ? [] : [this.section(t, "Options", h_flex().flex_wrap().gap(8).children(ask.options.map((option) => this.option(t, item, option))))])
      .children(item.recommendation === null ? [] : [this.section(t, "Recommendation", linkedText(`recommendation-${item.key}`, item.recommendation))])
      .children(this.actions(t, item))
      .children(this.failure(t, item.key))
  }

  section(t: Palette, label: string, content: Element): Element {
    return v_flex().gap(2).child(div().text_size(11).text_color(t.dim).child(label)).child(content)
  }

  option(t: Palette, item: InboxItem, option: AskOption): Element {
    const id = `option-${item.key}-${option.letter}`
    const label = `${option.letter}) ${option.text}`
    const shape = optionShape(option)
    const shown = shape.kind === "tile"
      ? v_flex().id(id).w(180).rounded(6).border(1).border_color(t.border).bg(t.background).overflow_hidden()
        .child(Avatar.new().w(180).h(112).overflow_hidden()
          .image(new AvatarImage(shape.picture).size_full())
          .fallback(AvatarFallback.new().size_full().items_center().justify_center().p(6).text_size(11).text_color(t.muted).child(shape.picture)))
        .child(div().p(6).child(label))
      : div().id(id).px(12).py(4).rounded(6).border(1).border_color(t.border).bg(t.background).child(label)
    const target = answerTarget(item)
    if (target === null || target.kind !== "question" || this.sent.get(item.key)?.kind === "sending") return shown
    return shown.cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.answer(cx, item, target, option.text, () => undefined))
  }

  button(t: Palette, id: string, label: string, busy: boolean, press: (cx: Context) => void): Element {
    const button = div().id(id).flex_shrink_0().px(12).py(4).rounded(6).border(1).border_color(t.border).bg(t.raised)
    return busy
      ? button.text_color(t.dim).child(label)
      : button.cursor_pointer().hover((style) => style.bg(t.hover)).on_click((_event, cx) => press(cx)).child(label)
  }

  actions(t: Palette, item: InboxItem): ReadonlyArray<Element> {
    const sending = this.sent.get(item.key)?.kind === "sending"
    if (item.action?.kind === "merge") return [h_flex().child(this.button(t, `approve-${item.key}`, sending ? "Merging" : "Approve", sending, () => this.askMerge(item)))]
    const target = answerTarget(item)
    const box = this.boxes.get(item.key)
    if (target === null || box === undefined) return []
    return [h_flex().gap(8).items_center()
      .child(Input.new(box).flex_1().h(32).px(8).rounded(6).border(1).border_color(t.border).bg(t.background))
      .child(this.button(t, `send-${item.key}`, sending ? "Sending" : "Send", sending, (cx) => this.answerFromBox(cx, item, target)))]
  }

  failure(t: Palette, key: string): ReadonlyArray<Element> {
    const sent = this.sent.get(key)
    return sent?.kind === "failed" ? [div().text_color(t.blocked).child(sent.reason)] : []
  }
}
