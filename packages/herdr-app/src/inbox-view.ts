import { type Context, type Element, div } from "gpui-kit"
import { Input, InputState, h_flex, v_flex } from "gpui-base"
import { type Sent, actionButton, failureLine, optionView, section, sendOrc } from "./ask-view"
import { type InboxApproval, type InboxItem, choice, inboxArgv } from "./inbox"
import { linkedText } from "./links-view"
import type { palette } from "./palette"
import { shortTime } from "./task"
import { type AskOption, whoLabel } from "./thread"

type Palette = ReturnType<typeof palette>

const inboxKind: Readonly<Record<InboxItem["kind"], string>> = {
  question: "Question", decision: "Decision", hold: "Hold", pr: "PR", event: "Event"
}

const ageLabel = (seconds: number): string => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds / 3600) % 24
  const minutes = Math.floor(seconds / 60) % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return minutes > 0 ? `${minutes}m` : `${seconds}s`
}

type WriteChoice = Extract<ReturnType<typeof choice>, { kind: "write" }>
type AskMerge = (item: InboxApproval) => void

const needsAnswerBox = (item: InboxItem): boolean =>
  item.action.kind !== "merge" && item.action.kind !== "unavailable" &&
  (item.ask.options.length === 0 || item.ask.options.some((option) => choice(item, option).kind === "write"))

export class InboxAnswers {
  readonly boxes = new Map<string, InputState>()
  readonly sent = new Map<string, Sent>()
  readonly recorded = new Set<string>()
  readonly writing = new Map<string, WriteChoice>()
  readonly reload: (cx: Context) => void

  constructor(reload: (cx: Context) => void) {
    this.reload = reload
  }

  sync(cx: Context, items: ReadonlyArray<InboxItem>): void {
    const wanted = new Set(items.map((item) => item.key))
    let changed = false
    for (const key of this.recorded) if (!wanted.has(key)) this.recorded.delete(key)
    for (const key of this.sent.keys()) if (!wanted.has(key)) this.sent.delete(key)
    for (const [key, box] of this.boxes) {
      if (wanted.has(key)) continue
      box.release()
      this.boxes.delete(key)
      this.writing.delete(key)
      changed = true
    }
    for (const item of items) {
      if (this.boxes.has(item.key) || !needsAnswerBox(item)) continue
      const box = InputState.new({ placeholder: "Write an answer" })
      box.on("submit", (_event, submitCx) => this.answerFromBox(submitCx, item))
      this.boxes.set(item.key, box)
      changed = true
    }
    if (changed) cx.notify()
  }

  busy(key: string): boolean {
    return this.recorded.has(key) || this.sent.get(key)?.kind === "sending"
  }

  send(cx: Context, item: InboxItem, argv: ReadonlyArray<string>): void {
    if (this.busy(item.key)) return
    sendOrc(this, cx, item.key, argv, () => {
      this.recorded.add(item.key)
      this.boxes.get(item.key)?.set_value("")
    })
  }

  answerFromBox(cx: Context, item: InboxItem): void {
    const box = this.boxes.get(item.key)
    if (box === undefined) return
    const argv = inboxArgv(item, box.value(), this.writing.get(item.key)?.prefix)
    if (argv !== null) this.send(cx, item, argv)
  }

  choose(cx: Context, item: InboxItem, option: AskOption, askMerge: AskMerge): void {
    if (this.busy(item.key)) return
    const action = choice(item, option)
    switch (action.kind) {
      case "reply": {
        const argv = inboxArgv(item, action.words)
        if (argv !== null) this.send(cx, item, argv)
        break
      }
      case "write": {
        this.writing.set(item.key, action)
        this.boxes.get(item.key)?.focus()
        cx.notify()
        break
      }
      case "merge": {
        if (item.kind === "pr") askMerge(item)
        break
      }
      case "unavailable": break
    }
  }

  option(t: Palette, item: InboxItem, option: AskOption, askMerge: AskMerge): Element {
    const display = optionView(t, `option-${item.key}-${option.letter}`, option).max_w_full().whitespace_normal()
    const button = option.text === item.recommendation ? display.border_color(t.accent) : display
    const enabled = !this.busy(item.key) && choice(item, option).kind !== "unavailable"
    return v_flex().gap(3).min_w_0().items_start()
      .child(enabled ? button.cursor_pointer().hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => this.choose(cx, item, option, askMerge)) : button.text_color(t.dim))
      .child(div().text_color(t.muted).whitespace_normal().child(option.outcome ?? "No outcome recorded"))
  }

  actions(t: Palette, item: InboxItem, askMerge: AskMerge): ReadonlyArray<Element> {
    if (this.recorded.has(item.key)) return [div().text_color(t.done).child("Answer recorded")]
    if (this.sent.get(item.key)?.kind === "sending") return [div().text_color(t.muted).child("Sending answer")]
    if (item.action.kind === "unavailable") return [div().text_color(t.muted).child("This answer cannot be sent from the app.")]
    if (item.kind === "pr" && item.ask.options.length === 0) return [h_flex().child(actionButton(t, `approve-${item.key}`, "Merge PR", false, () => askMerge(item)))]
    const box = this.boxes.get(item.key)
    const writing = this.writing.get(item.key)
    if (box === undefined || (item.ask.options.length > 0 && writing === undefined)) return []
    return [section(t, writing?.label ?? "Your answer", h_flex().gap(8).items_center()
      .child(Input.new(box).flex_1().min_w_0().h(32).px(8).rounded(6).border(1).border_color(t.border).bg(t.background))
      .child(actionButton(t, `send-${item.key}`, "Send", false, (cx) => this.answerFromBox(cx, item))))]
  }

  item(t: Palette, item: InboxItem, askMerge: AskMerge): Element {
    const ask = item.ask
    return v_flex().id(`item-${item.key}`).gap(6).p(10).rounded(6).bg(t.raised).min_w_0().flex_shrink_0()
      .child(h_flex().gap(8).flex_wrap()
        .child(div().font_semibold().child(item.task))
        .child(div().min_w_0().text_color(t.muted).whitespace_normal().child(item.title)))
      .child(h_flex().gap(6).text_size(12).flex_wrap()
        .child(div().font_semibold().child(whoLabel(item)))
        .child(div().text_color(t.muted).child(inboxKind[item.kind]))
        .children(item.asked === null ? [] : [div().text_color(t.dim).child(shortTime(item.asked))])
        .children(item.overdueSeconds === undefined ? [] : [div().text_color(t.blocked).child(`Overdue · Waited ${ageLabel(item.overdueSeconds)}`)]))
      .child(section(t, "About", linkedText(`question-${item.key}`, ask.question).whitespace_normal()))
      .child(ask.options.length === 0 ? div().text_color(t.muted).child("No options recorded")
        : section(t, "Options", v_flex().gap(8).children(ask.options.map((option) => this.option(t, item, option, askMerge)))))
      .children(item.action.kind !== "event" ? [] : [div().text_color(t.muted).whitespace_normal().child("An answer records your choice. It does not run the command in the outcome.")])
      .child(section(t, "Recommendation", linkedText(`recommendation-${item.key}`, item.recommendation ?? "No recommendation recorded").whitespace_normal()))
      .children(this.actions(t, item, askMerge))
      .children(failureLine(t, this.sent.get(item.key)))
      .children(ask.context === null ? [] : [section(t, "Details", linkedText(`context-${item.key}`, ask.context).whitespace_normal())])
  }
}
