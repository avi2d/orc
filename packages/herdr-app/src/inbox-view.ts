import { type Context, type Element, div } from "gpui-kit"
import { Input, InputState, h_flex, v_flex } from "gpui-base"
import { type Sent, actionButton, failureLine, optionView, section, sendOrc } from "./ask-view"
import type { InboxAnswer, InboxItem } from "./inbox"
import { linkedText } from "./links-view"
import type { palette } from "./palette"
import { answerArgv, shortTime } from "./task"
import { type AskOption, whoLabel } from "./thread"

type Palette = ReturnType<typeof palette>

export const inboxKind: Readonly<Record<InboxItem["kind"], string>> = {
  question: "Question", decision: "Decision", hold: "Hold", pr: "PR"
}

export const inboxItemView = (t: Palette, item: InboxItem, options: (option: AskOption) => Element, actions: ReadonlyArray<Element>, sent: Sent | undefined): Element => {
  const ask = item.ask
  return v_flex().id(`item-${item.key}`).gap(6).p(10).rounded(6).bg(t.raised).min_w_0()
    .child(h_flex().gap(8).flex_wrap()
      .child(div().font_semibold().child(item.task))
      .child(div().min_w_0().text_color(t.muted).whitespace_normal().child(item.title)))
    .child(h_flex().gap(6).text_size(12).flex_wrap()
      .child(div().font_semibold().child(whoLabel(item)))
      .child(div().text_color(t.dim).child("·"))
      .child(div().text_color(t.muted).child(inboxKind[item.kind]))
      .children(item.asked === null ? [] : [div().text_color(t.dim).child("·"), div().text_color(t.dim).child(shortTime(item.asked))]))
    .children(ask.context === null ? [] : [section(t, "Context", linkedText(`context-${item.key}`, ask.context).whitespace_normal())])
    .child(section(t, "Question", linkedText(`question-${item.key}`, ask.question).whitespace_normal()))
    .children(ask.options.length === 0 ? [] : [section(t, "Options", h_flex().flex_wrap().gap(8).children(ask.options.map(options)))])
    .children(item.recommendation === null ? [] : [section(t, "Recommendation", linkedText(`recommendation-${item.key}`, item.recommendation).whitespace_normal())])
    .children(actions)
    .children(failureLine(t, sent))
}

export class InboxAnswers {
  readonly boxes = new Map<string, InputState>()
  readonly sent = new Map<string, Sent>()

  readonly reload: (cx: Context) => void

  constructor(reload: (cx: Context) => void) {
    this.reload = reload
  }

  // InputState.new refuses to run during render.
  sync(cx: Context, items: ReadonlyArray<InboxAnswer>, unread: ReadonlyMap<string, string>): void {
    const wanted = new Set(items.map((item) => item.key))
    let changed = false
    for (const [key, box] of this.boxes) {
      const task = key.slice(0, key.indexOf("/"))
      if (wanted.has(key) || unread.has(task)) continue
      box.release()
      this.boxes.delete(key)
      changed = true
    }
    for (const item of items) {
      if (this.boxes.has(item.key)) continue
      const target = item.action.target
      const box = InputState.new({ placeholder: target.kind === "hold" ? "Answer the hold" : `Answer ${target.id}` })
      box.on("submit", (_event, submitCx) => this.answerFromBox(submitCx, item))
      this.boxes.set(item.key, box)
      changed = true
    }
    if (changed) cx.notify()
  }

  answer(cx: Context, item: InboxAnswer, words: string, done: () => void): void {
    if (this.sent.get(item.key)?.kind === "sending") return
    const argv = answerArgv(item.task, item.action.target, words)
    if (argv !== null) sendOrc(this, cx, item.key, argv, done)
  }

  answerFromBox(cx: Context, item: InboxAnswer): void {
    const box = this.boxes.get(item.key)
    if (box === undefined) return
    this.answer(cx, item, box.value(), () => {
      if (this.boxes.get(item.key) === box) box.set_value("")
    })
  }

  option(t: Palette, item: InboxAnswer, option: AskOption): Element {
    const plain = optionView(t, `option-${item.key}-${option.letter}`, option).max_w_full().whitespace_normal()
    const shown = option.text === item.recommendation ? plain.border(2).border_color(t.accent) : plain
    if (this.sent.get(item.key)?.kind === "sending") return shown
    return shown.cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.answer(cx, item, option.text, () => undefined))
  }

  actions(t: Palette, item: InboxAnswer): ReadonlyArray<Element> {
    const box = this.boxes.get(item.key)
    if (box === undefined) return []
    const sending = this.sent.get(item.key)?.kind === "sending"
    return [h_flex().gap(8).items_center()
      .child(Input.new(box).flex_1().min_w_0().h(32).px(8).rounded(6).border(1).border_color(t.border).bg(t.background))
      .child(actionButton(t, `send-${item.key}`, sending ? "Sending" : "Send", sending, (cx) => this.answerFromBox(cx, item)))]
  }

  item(t: Palette, item: InboxAnswer): Element {
    return inboxItemView(t, item, (option) => this.option(t, item, option), this.actions(t, item), this.sent.get(item.key))
  }
}
