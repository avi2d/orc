import { type Context, type Element, div } from "gpui-kit"
import { InputState, h_flex, v_flex } from "gpui-base"
import { type Sent, failureLine, optionView, section, sendOrc } from "./ask-view"
import { button, card, fieldWithButton, kbd, radio, zinc } from "./kit"
import { type InboxApproval, type InboxItem, choice, inboxArgv, optionByNumber } from "./inbox"
import { linkedCardText } from "./links-view"
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

type Choice = ReturnType<typeof choice>
type WriteChoice = Extract<Choice, { kind: "write" }>
type AskMerge = (item: InboxApproval) => void

export interface AnswerBoxes {
  readonly placeholder: string
  readonly pick: "send" | "fill"
}

const inboxBoxes: AnswerBoxes = { placeholder: "Write an answer", pick: "send" }

export const threadBoxes: AnswerBoxes = { placeholder: "Or write your own answer", pick: "fill" }

const askVerb: Readonly<Record<InboxItem["kind"], string>> = {
  question: "asks", decision: "asks for a decision", hold: "holds the task", pr: "asks to merge", event: "reports"
}

const keyedOptions = 9

const needsAnswerBox = (item: InboxItem): boolean =>
  item.action.kind !== "merge" && item.action.kind !== "unavailable"

export class InboxAnswers {
  readonly boxes = new Map<string, InputState>()
  readonly sent = new Map<string, Sent>()
  readonly recorded = new Set<string>()
  readonly writing = new Map<string, WriteChoice>()
  readonly picked = new Map<string, string>()
  readonly typed = new Map<string, string>()
  readonly items = new Map<string, InboxItem>()
  readonly reload: (cx: Context) => void
  readonly look: AnswerBoxes

  constructor(reload: (cx: Context) => void, look: AnswerBoxes = inboxBoxes) {
    this.reload = reload
    this.look = look
  }

  sync(cx: Context, items: ReadonlyArray<InboxItem>): void {
    const wanted = new Set(items.map((item) => item.key))
    for (const key of this.recorded) if (!wanted.has(key)) this.recorded.delete(key)
    for (const key of this.sent.keys()) if (!wanted.has(key)) this.sent.delete(key)
    for (const key of this.items.keys()) if (!wanted.has(key)) this.items.delete(key)
    for (const item of items) this.items.set(item.key, item)
    const dropped = this.dropBoxes(wanted)
    const added = this.addBoxes(items)
    if (dropped || added) cx.notify()
  }

  dropBoxes(wanted: ReadonlySet<string>): boolean {
    let dropped = false
    for (const [key, box] of this.boxes) {
      if (wanted.has(key)) continue
      box.release()
      this.boxes.delete(key)
      this.writing.delete(key)
      this.picked.delete(key)
      this.typed.delete(key)
      dropped = true
    }
    return dropped
  }

  addBoxes(items: ReadonlyArray<InboxItem>): boolean {
    let added = false
    for (const item of items) {
      if (this.boxes.has(item.key) || !needsAnswerBox(item)) continue
      const box = InputState.new({ placeholder: this.look.placeholder })
      box.on("submit", (_event, submitCx) => this.answerFromBox(submitCx, item))
      if (this.look.pick === "fill") box.on("change", (_event, changeCx) => this.typedIn(changeCx, item.key))
      this.boxes.set(item.key, box)
      added = true
    }
    return added
  }

  busy(key: string): boolean {
    return this.recorded.has(key) || this.sent.get(key)?.kind === "sending"
  }

  send(cx: Context, item: InboxItem, argv: ReadonlyArray<string>): void {
    if (this.busy(item.key)) return
    sendOrc(this, cx, item.key, argv, () => {
      this.recorded.add(item.key)
      this.picked.delete(item.key)
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

  focusBox(key: string): boolean {
    const box = this.boxes.get(key)
    box?.focus()
    return box !== undefined
  }

  typedIn(cx: Context, key: string): void {
    const box = this.boxes.get(key)
    const item = this.items.get(key)
    if (box === undefined || item === undefined) return
    const before = this.typed.get(key) ?? ""
    const after = box.value()
    this.typed.set(key, after)
    const option = this.writing.has(key) ? null : optionByNumber(item, before, after)
    if (option !== null && !this.busy(key)) this.fill(item, option)
    cx.notify()
  }

  fill(item: InboxItem, option: AskOption): void {
    const box = this.boxes.get(item.key)
    const action = choice(item, option)
    if (box === undefined || (action.kind !== "reply" && action.kind !== "write")) return
    if (action.kind === "reply") this.writing.delete(item.key)
    else this.writing.set(item.key, action)
    box.set_value(action.kind === "reply" ? action.words : "")
    this.typed.set(item.key, box.value())
    this.picked.set(item.key, option.letter)
    box.focus()
  }

  pick(cx: Context, item: InboxItem, option: AskOption, askMerge: AskMerge): void {
    if (this.busy(item.key)) return
    if (choice(item, option).kind === "merge" && item.kind === "pr") askMerge(item)
    else this.fill(item, option)
    cx.notify()
  }

  isPicked(item: InboxItem, option: AskOption): boolean {
    if (this.picked.get(item.key) !== option.letter) return false
    const action = choice(item, option)
    if (action.kind === "write") return this.writing.get(item.key)?.prefix === action.prefix
    return action.kind === "reply" && this.boxes.get(item.key)?.value() === action.words
  }

  optionRow(t: Palette, item: InboxItem, option: AskOption, index: number, askMerge: AskMerge): Element {
    const enabled = !this.busy(item.key) && choice(item, option).kind !== "unavailable"
    const checked = this.isPicked(item, option)
    const id = `option-${item.key}-${option.letter}`
    const outcome = option.outcome ?? "No outcome recorded"
    const row = h_flex().id(id).gap(10).items_start().px(8).py(6).rounded(6).min_w_0()
      .child(div().h(20).flex().items_center().child(radio(checked)))
      .child(v_flex().flex_1().min_w_0().gap(2)
        .child(h_flex().gap(8).items_center()
          .child(linkedCardText(`${id}-text`, option.text).text_size(13).font_weight(500).text_color(checked ? t.foreground : zinc.muted).whitespace_normal())
          .children(option.text === item.recommendation ? [div().text_size(12).text_color(t.muted).child("Recommended")] : []))
        .child(linkedCardText(`${id}-outcome`, outcome).text_size(12).text_color(t.muted).whitespace_normal())
        .children(option.picture === null ? [] : [linkedCardText(`${id}-picture`, `Picture: ${option.picture}`).text_size(12).text_color(t.dim).whitespace_normal()]))
      .children(index < keyedOptions ? [kbd(t, String(index + 1))] : [])
    return enabled
      ? row.cursor_pointer().hover((style) => style.bg(zinc.s2)).on_click((_event, cx) => this.pick(cx, item, option, askMerge))
      : row.opacity(0.5)
  }

  askActions(t: Palette, item: InboxItem): ReadonlyArray<Element> {
    if (this.recorded.has(item.key)) return [div().text_color(t.done).child("Answer recorded")]
    if (this.sent.get(item.key)?.kind === "sending") return [div().text_color(t.muted).child("Sending answer")]
    if (item.action.kind === "unavailable") return [div().text_color(t.muted).child("This answer cannot be sent from the app.")]
    const box = this.boxes.get(item.key)
    if (box === undefined) return []
    const writing = this.writing.get(item.key)
    return [
      ...(writing === undefined ? [] : [div().text_size(12).text_color(t.muted).child(writing.label)]),
      fieldWithButton(box, button(t, `send-${item.key}`, "Send", "primary", 32, (cx) => this.answerFromBox(cx, item)))
    ]
  }

  askCard(t: Palette, item: InboxItem, askMerge: AskMerge): Element {
    const ask = item.ask
    const asked = [`${whoLabel(item)} ${askVerb[item.kind]}`, ...(item.asked === null ? [] : [shortTime(item.asked)])].join(" · ")
    return card().id(`ask-${item.key}`).p(12).gap(8).min_w_0().flex_shrink_0()
      .child(h_flex().gap(8).text_size(12).flex_wrap()
        .child(div().text_color(t.muted).child(asked))
        .children(item.overdueSeconds === undefined ? [] : [div().text_color(t.blocked).child(`Overdue · Waited ${ageLabel(item.overdueSeconds)}`)]))
      .child(linkedCardText(`ask-question-${item.key}`, ask.question).font_weight(600).whitespace_normal())
      .children(ask.context === null ? [] : [linkedCardText(`ask-context-${item.key}`, ask.context).whitespace_normal()])
      .child(ask.options.length === 0 ? div().text_size(12).text_color(t.muted).child("No options recorded")
        : v_flex().gap(2).children(ask.options.map((option, index) => this.optionRow(t, item, option, index, askMerge))))
      .children(item.recommendation === null || ask.options.some((option) => option.text === item.recommendation) ? []
        : [linkedCardText(`ask-recommendation-${item.key}`, `Recommended: ${item.recommendation}`).text_size(12).text_color(t.muted).whitespace_normal()])
      .children(item.action.kind !== "event" ? [] : [div().text_size(12).text_color(t.muted).whitespace_normal().child("An answer records your choice. It does not run the command in the outcome.")])
      .children(this.askActions(t, item))
      .children(failureLine(t, this.sent.get(item.key)))
  }

  option(t: Palette, item: InboxItem, option: AskOption, askMerge: AskMerge): Element {
    const enabled = !this.busy(item.key) && choice(item, option).kind !== "unavailable"
    const display = optionView(t, `option-${item.key}-${option.letter}`, option, (control) => {
      const shown = control.max_w_full().whitespace_normal().when(option.text === item.recommendation, (tile) => tile.border_color(t.accent))
      return enabled ? shown.cursor_pointer().hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => this.choose(cx, item, option, askMerge)) : shown.text_color(t.dim)
    })
    return v_flex().gap(3).min_w_0().items_start()
      .child(display)
      .child(linkedCardText(`option-outcome-${item.key}-${option.letter}`, option.outcome ?? "No outcome recorded").text_color(t.muted).whitespace_normal())
  }

  actions(t: Palette, item: InboxItem, askMerge: AskMerge): ReadonlyArray<Element> {
    if (this.recorded.has(item.key)) return [div().text_color(t.done).child("Answer recorded")]
    if (this.sent.get(item.key)?.kind === "sending") return [div().text_color(t.muted).child("Sending answer")]
    if (item.action.kind === "unavailable") return [div().text_color(t.muted).child("This answer cannot be sent from the app.")]
    if (item.kind === "pr" && item.ask.options.length === 0) return [h_flex().justify_end().child(button(t, `approve-${item.key}`, "Merge PR", "primary", 32, () => askMerge(item)))]
    const box = this.boxes.get(item.key)
    if (box === undefined) return []
    return [section(t, this.writing.get(item.key)?.label ?? "Your answer",
      fieldWithButton(box, button(t, `send-${item.key}`, "Send", "primary", 32, (cx) => this.answerFromBox(cx, item))))]
  }

  item(t: Palette, item: InboxItem, askMerge: AskMerge): Element {
    const ask = item.ask
    return card().id(`item-${item.key}`).gap(6).p(12).min_w_0().flex_shrink_0()
      .child(h_flex().gap(8).flex_wrap()
        .child(div().font_semibold().child(item.task))
        .child(linkedCardText(`title-${item.key}`, item.title).min_w_0().text_color(t.muted).whitespace_normal()))
      .child(h_flex().gap(6).text_size(12).flex_wrap()
        .child(div().font_semibold().child(whoLabel(item)))
        .child(div().text_color(t.muted).child(inboxKind[item.kind]))
        .children(item.asked === null ? [] : [div().text_color(t.muted).child(shortTime(item.asked))])
        .children(item.overdueSeconds === undefined ? [] : [div().text_color(t.blocked).child(`Overdue · Waited ${ageLabel(item.overdueSeconds)}`)]))
      .child(section(t, "About", linkedCardText(`question-${item.key}`, ask.question).whitespace_normal()))
      .child(ask.options.length === 0 ? div().text_color(t.muted).child("No options recorded")
        : section(t, "Options", v_flex().gap(8).children(ask.options.map((option) => this.option(t, item, option, askMerge)))))
      .children(item.action.kind !== "event" ? [] : [div().text_color(t.muted).whitespace_normal().child("An answer records your choice. It does not run the command in the outcome.")])
      .child(section(t, "Recommendation", linkedCardText(`recommendation-${item.key}`, item.recommendation ?? "No recommendation recorded").whitespace_normal()))
      .children(this.actions(t, item, askMerge))
      .children(failureLine(t, this.sent.get(item.key)))
      .children(ask.context === null ? [] : [section(t, "Details", linkedCardText(`context-${item.key}`, ask.context).whitespace_normal())])
  }
}
