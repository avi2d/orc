import { type Context, type Element, div } from "gpui-kit"
import { h_flex } from "gpui-base"
import { agentLabel, opensTurns } from "./agent-label"
import type { ShownStep } from "./guard"
import type { palette } from "./palette"

type Palette = ReturnType<typeof palette>
export type Pane = "parsed" | "raw"
type SetPane = (cx: Context, pane: Pane) => void

const paneChoice = (t: Palette, pane: Pane, label: string, on: boolean, setPane: SetPane): Element =>
  div().id(`pane-${pane}`).px(10).py(2).rounded(4).cursor_pointer()
    .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => setPane(cx, pane))
    .child(label)

const parsedPane = (step: ShownStep): string | null =>
  step.name === "checks" ? "Summary" : opensTurns(step) ? "Turns" : null

export const stepBar = (t: Palette, step: ShownStep, title: string, source: string, pane: Pane, setPane: SetPane): Element => {
  const agent = agentLabel({ model: step.model, effort: step.thinking })
  const parsed = parsedPane(step)
  return h_flex().px(16).h(40).gap(12).flex_shrink_0().items_center().border_b(1).border_color(t.border)
    .child(div().flex_shrink_0().font_semibold().child(title))
    .children(agent === null ? [] : [div().flex_shrink_0().text_size(12).text_color(t.muted).child(agent)])
    .children(parsed === null
      ? []
      : [h_flex().gap(2).flex_shrink_0().child(paneChoice(t, "parsed", parsed, pane === "parsed", setPane)).child(paneChoice(t, "raw", "Raw", pane === "raw", setPane))])
    .child(div().flex_1().min_w_0().truncate().text_right().text_size(12).text_color(t.dim).child(source))
}
