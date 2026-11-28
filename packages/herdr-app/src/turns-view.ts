import { type Context, type Element, div } from "gpui-kit"
import { type ScrollHandle, h_flex, v_flex } from "gpui-base"
import { monospace } from "./fonts"
import { linkedText } from "./links-view"
import type { Reading } from "./orc-read"
import type { palette } from "./palette"
import { type Turn, type TurnCall, callMark, outputSize, outputStart, turnHeader } from "./turns"

type Palette = ReturnType<typeof palette>

export interface TurnsOpen {
  readonly thinking: ReadonlySet<string>
  readonly calls: ReadonlySet<string>
}

export interface TurnsActions {
  readonly toggleThinking: (turn: string, cx: Context) => void
  readonly toggleCall: (call: string, cx: Context) => void
}

export interface TurnsWords {
  readonly reading: string
  readonly empty: string
}

const outputLines = 20

const clock = (at: number): string => {
  const time = new Date(at)
  return `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}`
}

const turnLines = (id: string, text: string): ReadonlyArray<Element> =>
  text.split("\n").map((line, index) => linkedText(`${id}-${index}`, line === "" ? " " : line))

const callView = (t: Palette, call: TurnCall, open: boolean, act: TurnsActions): Element => {
  const mark = callMark(call.result)
  const row = h_flex().id(`call-${call.id}`).gap(8).px(6).py(2).rounded(4).items_center().cursor_pointer()
    .hover((style) => style.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_event, cx) => act.toggleCall(call.id, cx))
    .child(div().flex_shrink_0().text_color(t.dim).child(call.number))
    .child(div().w(12).flex_shrink_0().text_color(mark === "✓" ? t.done : mark === "✗" ? t.ansi1 : t.working).child(mark))
    .child(div().flex_shrink_0().font_semibold().child(call.name))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(call.arguments))
    .child(div().flex_shrink_0().text_color(t.dim).child(outputSize(call.result)))
  if (!open || call.result.kind === "running") return row
  const output = call.result.output === "" ? "No output" : outputStart(call.result.output, outputLines)
  return v_flex().child(row)
    .child(v_flex().ml(26).my(4).px(10).py(6).rounded(4).bg(t.chrome).font_family(monospace()).text_size(12)
      .text_color(call.result.kind === "failed" ? t.ansi1 : t.foreground)
      .children(turnLines(`call-output-${call.id}`, output)))
}

const turnView = (t: Palette, turn: Turn, open: TurnsOpen, act: TurnsActions): Element => {
  const header = h_flex().justify_between().items_start().gap(8).text_size(12).text_color(t.dim)
    .child(div().flex_shrink_0().font_semibold().text_color(t.foreground).child(turn.number.toString()))
    .child(div().flex_1().min_w(0).child(turnHeader(turn)))
    .child(div().flex_shrink_0().child(clock(turn.at)))
  const thinkingOpen = open.thinking.has(turn.id)
  return v_flex().id(`turn-${turn.id}`).gap(8).p(12).rounded(6).bg(t.raised)
    .child(header)
    .when(turn.thinking !== "", (block) => block.child(v_flex().gap(4)
      .child(div().id(`thinking-${turn.id}`).cursor_pointer().text_color(t.muted).hover((style) => style.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_event, cx) => act.toggleThinking(turn.id, cx))
        .child(`${thinkingOpen ? "▾" : "▸"} Thinking`))
      .when(thinkingOpen, (column) => column.child(v_flex().pl(14).text_color(t.muted).italic().children(turnLines(`thinking-text-${turn.id}`, turn.thinking))))))
    .when(turn.text !== "", (block) => block.child(v_flex().children(turnLines(`turn-text-${turn.id}`, turn.text))))
    .when(turn.calls.length > 0, (block) => block.child(v_flex().gap(2).children(turn.calls.map((call) => callView(t, call, open.calls.has(call.id), act)))))
}

export const turnsView = (t: Palette, reading: Reading<ReadonlyArray<Turn>>, open: TurnsOpen, act: TurnsActions, scroll: ScrollHandle, words: TurnsWords): Element => {
  const note = (text: string, color: Palette[keyof Palette]): Element => div().p(16).text_color(color).child(text)
  if (reading.kind === "reading") return note(words.reading, t.muted)
  if (reading.kind === "failed") return note(reading.reason, t.blocked)
  if (reading.value.length === 0) return note(words.empty, t.muted)
  return v_flex().id("turns").size_full().overflow_y_scrollbar().track_scroll(scroll).p(12).gap(10).text_size(13).text_color(t.foreground)
    .children(reading.value.map((turn) => turnView(t, turn, open, act)))
}
