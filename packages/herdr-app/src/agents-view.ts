import { type Color, type Context, type Element, div } from "gpui-kit"
import { Input, type InputState, type ScrollHandle, h_flex, v_flex } from "gpui-base"
import { openOverlay } from "herdr"
import { type MergeOutcome, approvalShown } from "./approval-stage"
import { monospace } from "./fonts"
import { type Card, type Mark, type StepRow, approveRow, prNumber, sendBackArgs, stepRows } from "./agents"
import { namedModels, opensTurns } from "./run-agent"
import { type ChecksSummary, logLines } from "./checks"
import { checksView } from "./checks-view"
import type { RunsActions } from "./runs-view"
import type { Show, ShownStep } from "./guard"
import type { InboxApproval } from "./inbox"
import { linkedText } from "./links-view"
import { type Reading, readText } from "./orc-read"
import type { palette } from "./palette"
import { type Pane, stepBar } from "./step-bar"
import { type Turn } from "./turns"
import { turnsView } from "./turns-view"

type Palette = ReturnType<typeof palette>

export type Chosen = { readonly kind: "step"; readonly id: number } | { readonly kind: "approve" }

export interface AgentsActions extends RunsActions {
  readonly choose: (cx: Context, chosen: Chosen) => void
  readonly setPane: (cx: Context, pane: Pane) => void
  readonly askMerge: (card: Card, approval: InboxApproval) => void
}

export const approvalOf = (card: Card | null): InboxApproval | null =>
  card?.standing.status === "Awaiting you" && card.standing.waiting.on === "approval" ? card.standing.waiting.item : null

const markColor = (t: Palette, mark: Mark): Color => {
  switch (mark) {
    case "✓":
      return t.done
    case "✗":
      return t.ansi1
    case "●":
      return t.working
    case "◆":
      return t.blocked
    case "○":
      return t.dim
  }
}

const rowTarget = (row: StepRow): Chosen | null => {
  if (row.stepId !== null) {
    return { kind: "step", id: row.stepId }
  }
  return row.key === approveRow ? { kind: "approve" } : null
}

const sameTarget = (a: Chosen, b: Chosen): boolean =>
  a.kind === "approve" ? b.kind === "approve" : b.kind === "step" && b.id === a.id

const rowView = (t: Palette, row: StepRow, target: Chosen | null, model: string | null, act: AgentsActions): Element => {
  const opens = rowTarget(row)
  const selected = opens !== null && target !== null && sameTarget(opens, target)
  const line = h_flex().id(`row-${row.key}`).px(8).py(4).gap(8).rounded(4).items_center()
    .bg(selected ? t.selected : t.surface)
    .child(div().w(14).flex_shrink_0().text_color(row.mark === null ? t.dim : markColor(t, row.mark)).child(row.mark ?? ""))
    .child(div().flex_shrink_0().text_color(opens === null ? t.muted : t.foreground).child(row.label))
    .children(model === null ? [] : [div().flex_1().min_w_0().truncate().text_size(12).text_color(t.dim).child(model)])
  return opens === null
    ? line
    : line.cursor_pointer().hover((style) => style.bg(selected ? t.selected : t.hover)).on_click((_event, cx) => act.choose(cx, opens))
}

interface StepsShown {
  readonly reading: Reading<Show> | null
  readonly target: Chosen | null
  readonly changesProblem: string | null
}

const stepViews = (t: Palette, card: Card, shown: StepsShown, act: AgentsActions): ReadonlyArray<Element> => {
  const { reading, target } = shown
  if (reading?.kind === "failed") return [div().p(6).text_color(t.blocked).whitespace_normal().child(reading.reason)]
  if (reading?.kind === "reading") return [div().p(6).text_color(t.muted).child("Reading its steps")]
  const steps = reading?.value.steps ?? []
  const models = namedModels(steps)
  return stepRows(card.standing, steps, card.kind, card.delivery).map((row) =>
    rowView(t, row, target, row.stepId === null ? null : models.get(row.stepId) ?? null, act))
}

export const stepsColumn = (t: Palette, card: Card | null, shown: StepsShown, act: AgentsActions): Element => {
  const waiting = card?.standing.status === "Awaiting you"
  const column = v_flex().id("steps-column").w(240).h_full().flex_shrink_0().border_r(1).border_color(t.border)
  if (card === null) return column
  const runLabel = card.runId ?? (waiting ? null : "No run yet")
  const header = v_flex().px(12).py(10).gap(2).border_b(1).border_color(t.border)
    .child(div().font_semibold().truncate().child(card.title))
    .children(runLabel === null ? [] : [div().text_size(12).text_color(t.dim).truncate().child(runLabel)])
  const { changesProblem } = shown
  return column.child(header)
    .child(v_flex().id("steps").flex_1().min_h_0().overflow_y_scrollbar().p(6).gap(4)
      .children(stepViews(t, card, shown, act)))
    .children(changesProblem === null ? [] : [div().px(12).py(8).border_t(1).border_color(t.border).text_size(12).text_color(t.blocked).child(`No Changes column: ${changesProblem}`)])
}

const detailPane = (t: Palette, parts: ReadonlyArray<Element>): Element =>
  v_flex().flex_1().min_w_0().h_full().bg(t.background).children(parts)

const detailNote = (t: Palette, text: string): Element =>
  detailPane(t, [div().p(16).text_color(t.muted).child(text)])

const approvePane = (t: Palette, card: Card, approval: InboxApproval, merge: MergeOutcome | null, act: AgentsActions): Element => {
  const pr = prNumber(approval.link)
  const merging = merge?.kind === "merging"
  const shown = approvalShown(merge, card.merge)
  const button = h_flex().id("approve-merge").h(32).px(14).items_center().rounded(8).text_size(13)
    .bg(merging ? t.raised : t.solid).text_color(merging ? t.dim : t.solid_foreground)
    .child(shown.button)
  return detailPane(t, [
    h_flex().px(16).h(40).flex_shrink_0().items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(`Approve ${pr}`)),
    v_flex().p(16).gap(12).items_start()
      .child(div().child(card.title))
      .child(div().text_color(t.muted).child(linkedText(`approve-${card.key}`, approval.link)))
      .child(div().text_color(t.muted).child(`${pr} waits for your approval. Merging runs orc ${approval.action.argv.join(" ")}.`))
      .child(merging ? button : button.cursor_pointer().hover((style) => style.opacity(0.88)).on_click(() => act.askMerge(card, approval)))
      .children(shown.notice === null ? [] : [div().text_color(t.ansi1).child(shown.notice)])
  ])
}

const logBody = (t: Palette, reading: Reading<string>, scroll: ScrollHandle): Element => {
  if (reading.kind === "failed") {
    return div().p(16).text_color(t.blocked).child(reading.reason)
  }
  if (reading.kind === "reading") {
    return div().p(16).text_color(t.muted).child("Reading the step's output")
  }
  if (reading.value === "") {
    return div().p(16).text_color(t.muted).child("Nothing written yet")
  }
  return v_flex().id("log").flex_1().overflow_y_scrollbar().track_scroll(scroll).px(16).py(10)
    .font_family(monospace()).text_size(12)
    .children(logLines(reading.value).map((text) => div().child(text === "" ? " " : text)))
}

const stepTitle = (card: Card, steps: ReadonlyArray<ShownStep>, stepId: number): string =>
  stepRows(card.standing, steps, card.kind, card.delivery).find((row) => row.stepId === stepId)?.label ?? "Step"

export const askMerge = (approval: InboxApproval, command: string): void => {
  const pr = prNumber(approval.link)
  openOverlay({
    mod: "confirm",
    kind: "dialog",
    width: 440,
    height: 190,
    props: {
      title: `Merge ${pr}?`,
      detail: `orc ${approval.action.argv.join(" ")} squashes ${pr} into its base branch.`,
      command: { name: command }
    }
  })
}

export interface Keyed<A> {
  readonly of: string
  readonly reading: Reading<A>
}

export interface SendBackMod {
  selectedCard(): Card | null
  readonly review: InputState
  sent: Keyed<string> | null
  refresh(cx: Context): void
}

export const submitSendBack = (mod: SendBackMod, cx: Context): void => {
  const card = mod.selectedCard()
  const args = card === null ? null : sendBackArgs(card, mod.review.value())
  if (card === null || args === null || mod.sent?.reading.kind === "reading") {
    return
  }
  mod.sent = { of: card.key, reading: { kind: "reading" } }
  cx.notify()
  cx.spawn((task) =>
    readText("orc", [...args]).then((reading) => {
      mod.sent = { of: card.key, reading }
      if (reading.kind === "ok") {
        mod.review.set_value("")
      }
      mod.refresh(task)
      task.notify()
    })
  )
}

export const sendBackBar = (t: Palette, card: Card, review: InputState, sent: Reading<string> | null, send: (cx: Context) => void): ReadonlyArray<Element> => {
  const said = sent === null ? [] : [div().text_size(12).text_color(sent.kind === "failed" ? t.blocked : t.muted).child(sent.kind === "reading" ? "Sending it back" : sent.kind === "ok" ? sent.value.trim() : sent.reason)]
  if (card.sendBack === null) {
    return sent?.kind === "ok" ? [v_flex().px(16).py(8).border_b(1).border_color(t.border).children(said)] : []
  }
  const ready = sendBackArgs(card, review.value()) !== null && sent?.kind !== "reading"
  const button = div().id("send-back").px(10).py(4).rounded(4).flex_shrink_0().bg(t.selected).text_color(ready ? t.foreground : t.dim).child(sent?.kind === "reading" ? "Sending back" : "Send back")
  return [v_flex().px(16).py(8).gap(6).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w_0().child(Input.new(review)))
      .child(ready ? button.cursor_pointer().hover((style) => style.bg(t.hover)).on_click((_event, cx) => send(cx)) : button))
    .children(said)]
}

export interface DetailShown {
  readonly target: Chosen | null
  readonly merge: MergeOutcome | null
  readonly step: ShownStep | null
  readonly steps: ReadonlyArray<ShownStep>
  readonly back: ReadonlyArray<Element>
  readonly pane: Pane
  readonly turns: Reading<ReadonlyArray<Turn>>
  readonly log: Reading<string>
  readonly summary: Reading<ChecksSummary>
  readonly thinking: ReadonlySet<string>
  readonly calls: ReadonlySet<string>
  readonly checks: ReadonlySet<string>
  readonly turnsScroll: ScrollHandle
  readonly logScroll: ScrollHandle
  readonly checksScroll: ScrollHandle
  readonly flipThinking: (turn: string, cx: Context) => void
  readonly flipCall: (call: string, cx: Context) => void
  readonly flipCheck: (check: string, cx: Context) => void
}

export const detailView = (t: Palette, card: Card | null, act: AgentsActions, shown: DetailShown): Element => {
  if (card === null) {
    return detailNote(t, "No run selected")
  }
  const approval = approvalOf(card)
  if (approval !== null && shown.target?.kind === "approve") {
    const pane = approvePane(t, card, approval, shown.merge, act)
    return shown.back.length === 0 ? pane : detailPane(t, [...shown.back, pane])
  }
  if (card.runId === null) {
    return card.standing.status === "Awaiting you" ? detailPane(t, []) : detailNote(t, "The task has not started a run yet")
  }
  const step = shown.step
  if (step === null) {
    const settled = card.standing.status === "Failed" || card.standing.status === "Done"
    return detailNote(t, settled ? "This run ended before it recorded a step" : "No step has started yet")
  }
  return detailStep(t, card, card.runId, step, shown, act)
}

const detailStep = (t: Palette, card: Card, runId: string, step: ShownStep, shown: DetailShown, act: AgentsActions): Element => {
  const title = stepTitle(card, shown.steps, step.id)
  const log = `orc log ${runId} ${step.id}`
  if (step.name === "checks" && shown.pane === "parsed") {
    return detailPane(t, [...shown.back, stepBar(t, step, title, log, shown.pane, act.setPane),
      div().flex_1().min_h_0().child(checksView(t, shown.summary, { of: `${runId}/${step.id.toString()}`, flipped: shown.checks, flip: shown.flipCheck }, shown.checksScroll))])
  }
  if (opensTurns(step) && shown.pane === "parsed") {
    return detailPane(t, [...shown.back, stepBar(t, step, title, "Pi session", shown.pane, act.setPane),
      div().flex_1().min_h_0().child(turnsView(t, shown.turns, { thinking: shown.thinking, calls: shown.calls }, {
        toggleThinking: (turn, cx) => shown.flipThinking(turn, cx),
        toggleCall: (call, cx) => shown.flipCall(call, cx)
      }, shown.turnsScroll, { reading: "Reading the step's Pi session", empty: "No turn yet. Pi writes its session after its first reply." }))])
  }
  return detailPane(t, [...shown.back, stepBar(t, step, title, log, shown.pane, act.setPane), logBody(t, shown.log, shown.logScroll)])
}
