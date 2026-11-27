import { type Context, type Element, div } from "gpui-kit"
import { type ScrollHandle, h_flex, v_flex } from "gpui-base"
import { monospace } from "./fonts"
import { type CheckFailure, type CheckSummary, type ChecksSummary, checkTime } from "./checks"
import { type CheckState, alert, card, checkIcon } from "./kit"
import type { Reading } from "./orc-read"
import type { palette } from "./palette"

type Palette = ReturnType<typeof palette>

export interface ChecksShown {
  readonly of: string
  readonly flipped: ReadonlySet<string>
  readonly flip: (key: string, cx: Context) => void
}

const block = (t: Palette, lines: ReadonlyArray<string>): Element =>
  v_flex().px(10).py(6).rounded(8).bg(t.chrome).font_family(monospace()).text_size(12)
    .children(lines.map((line) => div().child(line === "" ? " " : line)))

const counts = (passCount: number | null, failCount: number | null): string =>
  [passCount === null ? null : `${passCount.toString()} pass`, failCount === null ? null : `${failCount.toString()} fail`].filter((part) => part !== null).join(" · ")

const failureView = (t: Palette, failure: CheckFailure): Element => {
  if (failure.kind === "tail") {
    return v_flex().ml(22).my(4).gap(4)
      .child(div().text_size(12).text_color(t.muted).child("Last lines before the exit"))
      .child(block(t, failure.lines))
  }
  const tally = counts(failure.passCount, failure.failCount)
  return v_flex().ml(22).my(4).gap(8)
    .children(failure.failed.map((test) => v_flex().gap(4)
      .child(h_flex().gap(8).items_center().child(checkIcon("failed")).child(div().min_w_0().whitespace_normal().child(test.name)))
      .children(test.error.length === 0 ? [] : [block(t, test.error)])))
    .children(tally === "" ? [] : [div().text_size(12).text_color(t.muted).child(tally)])
}

const checkState = (check: CheckSummary): CheckState => {
  switch (check.outcome.kind) {
    case "passed": return "passed"
    case "running": return "running"
    case "failed":
    case "interrupted":
      return "failed"
  }
}

const checkView = (t: Palette, check: CheckSummary, shown: ChecksShown): Element => {
  const outcome = check.outcome
  const key = `${shown.of}/${check.name}`
  const open = (outcome.kind === "failed" || outcome.kind === "interrupted") && !shown.flipped.has(key)
  const label = outcome.kind === "running" ? "Running" : outcome.kind === "interrupted" ? "Interrupted" : checkTime(check.seconds)
  const row = h_flex().id(`check-${check.name}`).h(24).gap(8).px(4).rounded(6).items_center()
    .child(checkIcon(checkState(check)))
    .child(div().flex_1().min_w(0).truncate().child(check.name))
    .child(div().flex_shrink_0().text_color(t.muted).child(label))
  if (outcome.kind !== "failed" && outcome.kind !== "interrupted") {
    return row
  }
  const toggle = row.cursor_pointer().hover((style) => style.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_event, cx) => shown.flip(key, cx))
    .child(div().w(12).flex_shrink_0().text_color(t.muted).child(open ? "▾" : "▸"))
  return open ? v_flex().child(toggle).child(failureView(t, outcome.failure)) : toggle
}

export const checksView = (t: Palette, reading: Reading<ChecksSummary>, shown: ChecksShown, scroll: ScrollHandle, unbounded: () => Element): Element => {
  const note = (id: string, shownAlert: Parameters<typeof alert>[2]): Element => v_flex().p(20).child(alert(t, id, shownAlert))
  if (reading.kind === "reading") return note("checks-reading", { tone: "info", title: "Reading the step's output" })
  if (reading.kind === "failed") return note("checks-failed", { tone: "error", title: "Could not read the checks", body: reading.reason })
  const checks = reading.value
  if (checks === null) return unbounded()
  if (checks.length === 0) return note("checks-none", { tone: "neutral", title: "No checks recorded" })
  return v_flex().id("checks").size_full().overflow_y_scrollbar().track_scroll(scroll).px(20).pb(20).text_size(13).text_color(t.foreground)
    .child(card().p(8).gap(2).children(checks.map((check) => checkView(t, check, shown))))
}
