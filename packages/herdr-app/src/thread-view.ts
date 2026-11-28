import { type Element, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { optionView, section } from "./ask-view"
import { waitsOnLabel } from "./inbox"
import { linkedText } from "./links-view"
import type { palette } from "./palette"
import { shortTime } from "./task"
import { type AgentDecidedLine, type AskOption, type DecidedLine, type Thread, type ThreadCard, type ThreadLine, lineLabel, threadDecisions, whoLabel } from "./thread"

type Palette = ReturnType<typeof palette>

export interface ThreadControls {
  readonly option: (card: ThreadCard, option: AskOption, shown: Element) => Element
  readonly reply: (card: ThreadCard) => ReadonlyArray<Element>
  readonly failure: (card: ThreadCard) => ReadonlyArray<Element>
}

export const readOnlyThread: ThreadControls = { option: (_card, _option, shown) => shown, reply: () => [], failure: () => [] }

const lineHeader = (t: Palette, line: ThreadLine, what: string): Element =>
  h_flex().gap(6).text_size(12)
    .child(div().font_semibold().child(whoLabel(line)))
    .child(div().text_color(t.dim).child("·"))
    .child(div().text_color(t.muted).child(what))
    .children(line.at === null ? [] : [div().text_color(t.dim).child("·"), div().text_color(t.dim).child(shortTime(line.at))])

const askBody = (t: Palette, card: ThreadCard, controls: ThreadControls): ReadonlyArray<Element> => {
  const ask = card.ask
  if (ask === null) return [linkedText(`text-${card.key}`, card.line.text)]
  const pictures = ask.options.flatMap((option) => option.picture === null ? [] : [`${option.letter}) ${option.picture}`])
  return [
    ...(ask.context === null ? [] : [section(t, "Context", linkedText(`context-${card.key}`, ask.context))]),
    section(t, "Question", linkedText(`question-${card.key}`, ask.question)),
    ...(ask.options.length === 0 ? [] : [section(t, "Options", h_flex().flex_wrap().gap(8).children(ask.options.map((option) =>
      optionView(t, `option-${card.key}-${option.letter}`, option, (shown) => controls.option(card, option, shown)))))]),
    ...(pictures.length === 0 ? [] : [section(t, "Evidence", v_flex().text_color(t.muted).children(pictures.map((picture, index) => linkedText(`picture-${card.key}-${index}`, picture))))])
  ]
}

const answerLine = (t: Palette, key: string, line: ThreadLine, delivered: boolean): Element =>
  v_flex().gap(4).p(8).rounded(6).bg(t.surface)
    .child(lineHeader(t, line, "Answer").children(delivered ? [div().text_color(t.done).child("· Delivered")] : []))
    .child(linkedText(key, line.text))

export const threadEntry = (t: Palette, card: ThreadCard, controls: ThreadControls): Element => {
  const answers = card.answers.map((line, index) => answerLine(t, `answer-${card.key}-${index}`, line, card.delivered && index === card.answers.length - 1))
  const shown = v_flex().id(`entry-${card.key}`).gap(6).p(10).rounded(6).bg(t.raised)
    .child(lineHeader(t, card.line, card.what)).children(askBody(t, card, controls)).children(answers)
    .children(controls.reply(card))
    .children(card.waitsOn.length === 0 ? [] : [div().text_color(t.muted).child(waitsOnLabel(card.waitsOn))])
    .children(controls.failure(card))
  const notes = card.notes.map((line, index) => v_flex().ml(24).gap(4).p(8).rounded(6).border_l(2).border_color(t.border).bg(t.surface)
    .child(lineHeader(t, line, lineLabel(line))).child(linkedText(`note-${card.key}-${index}`, line.text)))
  return v_flex().gap(6).child(shown).children(notes)
}

const decidedGroup = (t: Palette, key: string, heading: string, lines: ReadonlyArray<DecidedLine | AgentDecidedLine>): Element =>
  v_flex().id(`decided-by-${key}`).gap(6)
    .child(div().text_size(12).font_semibold().text_color(t.muted).child(heading))
    .children(lines.map((line) => v_flex().id(`decided-${key}-${line.key}`).gap(4).p(10).rounded(6).bg(t.raised).min_w_0()
      .child(div().text_size(12).font_semibold().child(line.what))
      .child(linkedText(`decided-text-${key}-${line.key}`, line.words))
      .children("basis" in line && line.basis !== null ? [section(t, "Basis", linkedText(`decided-basis-${key}-${line.key}`, line.basis).whitespace_normal())] : [])))

export const threadDecided = (t: Palette, told: Thread): ReadonlyArray<Element> => {
  const { owner, agent } = threadDecisions(told)
  return [
    ...(owner.length === 0 ? [] : [decidedGroup(t, "owner", "Decided by the owner", owner)]),
    ...(agent.length === 0 ? [] : [decidedGroup(t, "agent", "Decided by the agent", agent)])
  ]
}
