import { type Context, type Element, div } from "gpui-kit"
import { type ScrollHandle, h_flex, v_flex } from "gpui-base"
import { settings } from "herdr"
import { type CheckFailure, type CheckSummary, checkTime } from "./checks"
import type { Reading } from "./orc-read"
import type { palette } from "./palette"

type Palette = ReturnType<typeof palette>

export interface ChecksShown {
  readonly of: string
  readonly flipped: ReadonlySet<string>
  readonly flip: (key: string, cx: Context) => void
}

const monospace = (): string => {
  const family = settings()["font_family"]
  return typeof family === "string" ? family : "Menlo"
}

const block = (t: Palette, lines: ReadonlyArray<string>): Element =>
  v_flex().px(10).py(6).rounded(4).bg(t.chrome).font_family(monospace()).text_size(12)
    .children(lines.map((line) => div().child(line === "" ? " " : line)))

const counts = (passCount: number | null, failCount: number | null): string =>
  [passCount === null ? null : `${passCount.toString()} pass`, failCount === null ? null : `${failCount.toString()} fail`].filter((part) => part !== null).join(" · ")

const failureView = (t: Palette, failure: CheckFailure): Element => {
  if (failure.kind === "tail") {
    return v_flex().ml(26).my(4).gap(4)
      .child(div().text_size(12).text_color(t.dim).child("Last lines before the exit"))
      .child(block(t, failure.lines))
  }
  const tally = counts(failure.passCount, failure.failCount)
  return v_flex().ml(26).my(4).gap(8)
    .children(failure.failed.map((test) => v_flex().gap(4)
      .child(div().text_color(t.ansi1).child(`✗ ${test.name}`))
      .children(test.error.length === 0 ? [] : [block(t, test.error)])))
    .children(tally === "" ? [] : [div().text_size(12).text_color(t.muted).child(tally)])
}

const checkView = (t: Palette, check: CheckSummary, shown: ChecksShown): Element => {
  const outcome = check.outcome
  const key = `${shown.of}/${check.name}`
  const hasFailure = outcome.kind === "failed" || outcome.kind === "interrupted"
  const open = hasFailure && !shown.flipped.has(key)
  const mark = outcome.kind === "passed" ? "✓" : hasFailure ? "✗" : "…"
  const label = outcome.kind === "running" ? "Running" : outcome.kind === "interrupted" ? "Interrupted" : checkTime(check.seconds)
  const row = h_flex().id(`check-${check.name}`).gap(8).px(6).py(4).rounded(4).items_center()
    .child(div().w(12).flex_shrink_0().text_color(outcome.kind === "passed" ? t.done : hasFailure ? t.ansi1 : t.working).child(mark))
    .child(div().flex_1().min_w(0).truncate().font_semibold().child(check.name))
    .child(div().flex_shrink_0().text_color(t.dim).child(label))
  if (!hasFailure) {
    return row
  }
  const toggle = row.cursor_pointer().hover((style) => style.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_event, cx) => shown.flip(key, cx))
    .child(div().w(12).flex_shrink_0().text_color(t.muted).child(open ? "▾" : "▸"))
  return open ? v_flex().child(toggle).child(failureView(t, outcome.failure)) : toggle
}

export const checksView = (t: Palette, reading: Reading<ReadonlyArray<CheckSummary>>, shown: ChecksShown, scroll: ScrollHandle): Element => {
  const note = (text: string, color: Palette[keyof Palette]): Element => div().p(16).text_color(color).child(text)
  if (reading.kind === "reading") return note("Reading the step's output", t.muted)
  if (reading.kind === "failed") return note(reading.reason, t.blocked)
  const checks = reading.value
  if (checks.length === 0) return note("No checks recorded", t.muted)
  return v_flex().id("checks").size_full().overflow_y_scrollbar().track_scroll(scroll).p(12).gap(2).text_size(13).text_color(t.foreground)
    .children(checks.map((check) => checkView(t, check, shown)))
}
