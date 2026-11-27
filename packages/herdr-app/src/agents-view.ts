import { type Context, type Element, div } from "gpui-kit"
import { type InputState, type ScrollHandle, h_flex, v_flex } from "gpui-base"
import { openOverlay } from "herdr"
import { type MergeOutcome, approvalShown } from "./approval-stage"
import { monospace } from "./fonts"
import { type Card, type StepTab, prNumber, sendBackArgs, stepTabs } from "./agents"
import { namedModels, opensTurns } from "./run-agent"
import { type ChecksSummary, logLines } from "./checks"
import { checksView } from "./checks-view"
import type { RunsActions } from "./runs-view"
import type { Show, ShownStep } from "./guard"
import type { InboxApproval } from "./inbox"
import { type AlertShown, alert, button, card as kitCard, fieldWithButton, statusDot, tab } from "./kit"
import { linkedText } from "./links-view"
import { type Reading, readText } from "./orc-read"
import type { palette } from "./palette"
import { type Turn } from "./turns"
import { turnsView } from "./turns-view"

type Palette = ReturnType<typeof palette>

export type Chosen = { readonly kind: "thread" } | { readonly kind: "step"; readonly id: number } | { readonly kind: "approve" }

export interface AgentsActions extends RunsActions {
  readonly choose: (cx: Context, chosen: Chosen) => void
  readonly askMerge: (card: Card, approval: InboxApproval) => void
}

export const approvalOf = (card: Card | null): InboxApproval | null =>
  card?.standing.status === "Awaiting you" && card.standing.waiting.on === "approval" ? card.standing.waiting.item : null

export type LastTab = "Approve" | "Send back"

export const lastTab = (card: Card): LastTab | null => {
  if (approvalOf(card) !== null) return "Approve"
  return card.openPr !== null && card.sendBack !== null ? "Send back" : null
}

const sameTarget = (a: Chosen, b: Chosen | null): boolean => {
  if (b === null) return false
  return a.kind === "step" ? b.kind === "step" && b.id === a.id : a.kind === b.kind
}

const pane = (t: Palette, parts: ReadonlyArray<Element>): Element =>
  v_flex().flex_1().min_w_0().h_full().bg(t.background).children(parts)

const note = (t: Palette, id: string, shown: AlertShown): Element => v_flex().p(20).child(alert(t, id, shown))

const route = (card: Card): string | null => card.delivery ?? card.kind

const header = (t: Palette, card: Card): Element => {
  const where = [card.project, route(card), card.runId].filter((part) => part !== null).join(" · ")
  return v_flex().px(20).pt(14).pb(10).gap(6)
    .child(div().text_size(15).font_semibold().whitespace_normal().child(card.title))
    .child(h_flex().gap(8).items_center().min_w_0().text_size(13)
      .child(statusDot(card.standing.status).tooltip(card.standing.status))
      .child(div().min_w_0().truncate().child(card.where)))
    .child(div().text_size(12).text_color(t.muted).truncate().child(where))
}

const stepTabView = (t: Palette, step: StepTab, index: number, target: Chosen | null, models: ReadonlyMap<number, string>, act: AgentsActions): Element => {
  if (step.kind === "next") return tab(t, `tab-next-${index.toString()}`, step.label, false, null)
  const chosen: Chosen = { kind: "step", id: step.id }
  const made = tab(t, `tab-step-${step.id.toString()}`, step.label, sameTarget(chosen, target), (cx) => act.choose(cx, chosen))
  const model = models.get(step.id)
  return model === undefined ? made : made.tooltip(model)
}

const tabRow = (t: Palette, card: Card, reading: Reading<Show> | null, target: Chosen | null, act: AgentsActions): Element => {
  const steps = reading?.kind === "ok" ? reading.value.steps : []
  const shownSteps = card.runId === null || reading?.kind !== "ok" ? [] : stepTabs(card.standing, steps, card.kind, card.delivery)
  const models = namedModels(steps)
  const last = lastTab(card)
  const thread: Chosen = { kind: "thread" }
  const approve: Chosen = { kind: "approve" }
  return h_flex().id("tabs").px(16).pb(8).gap(4).flex_shrink_0().overflow_x_scrollbar().border_b(1).border_color(t.border)
    .child(tab(t, "tab-thread", "Thread", sameTarget(thread, target), (cx) => act.choose(cx, thread)))
    .children(shownSteps.map((step, index) => stepTabView(t, step, index, target, models, act)))
    .children(last === null ? [] : [tab(t, "tab-approve", last, sameTarget(approve, target), (cx) => act.choose(cx, approve))])
}

const openOnGitHub = (t: Palette, link: string): Element =>
  button(t, "open-pr", "Open on GitHub", "secondary", 32, (cx) => cx.open_url(link))

const approveBody = (t: Palette, card: Card, approval: InboxApproval, merge: MergeOutcome | null, act: AgentsActions): Element => {
  const merging = merge?.kind === "merging"
  const shown = approvalShown(merge, card.merge)
  return kitCard().p(12).gap(8)
    .child(div().text_size(12).text_color(t.muted).child(`Merging runs orc ${approval.action.argv.join(" ")}`))
    .child(linkedText(`approve-${card.key}`, approval.link))
    .child(h_flex().pt(4).gap(8).justify_end()
      .child(openOnGitHub(t, approval.link))
      .child(button(t, "approve-merge", shown.button, "primary", 32, merging ? null : () => act.askMerge(card, approval))))
    .children(shown.notice === null ? [] : [alert(t, "merge-notice", { tone: "error", title: "The merge stopped", body: shown.notice })])
}

export interface SendBackShown {
  readonly review: InputState
  readonly sent: Reading<string> | null
  readonly send: (cx: Context) => void
}

const sendBackBody = (t: Palette, card: Card, back: SendBackShown, withLink: boolean): ReadonlyArray<Element> => {
  const sent = back.sent
  const said = sent === null ? [] : [sent.kind === "failed"
    ? alert(t, "send-back-failed", { tone: "error", title: "Could not send it back", body: sent.reason })
    : div().text_size(12).text_color(t.muted).whitespace_normal().child(sent.kind === "reading" ? "Sending it back" : sent.value.trim())]
  if (card.sendBack === null) return sent?.kind === "ok" ? said : []
  const ready = sendBackArgs(card, back.review.value()) !== null && sent?.kind !== "reading"
  const label = sent?.kind === "reading" ? "Sending back" : "Send back"
  const send = button(t, "send-back", label, withLink ? "primary" : "secondary", 32, ready ? back.send : null)
  return [kitCard().p(12).gap(8)
    .child(div().text_size(12).text_color(t.muted).child("What to change before this PR merges"))
    .child(fieldWithButton(back.review, send))
    .children(withLink && card.openPr !== null ? [h_flex().justify_end().child(openOnGitHub(t, card.openPr))] : [])
    .children(said)]
}

const approveTab = (t: Palette, card: Card, shown: DetailShown, act: AgentsActions): Element => {
  const approval = approvalOf(card)
  return v_flex().id("approve").flex_1().min_h_0().overflow_y_scrollbar().p(20).gap(12)
    .children(approval === null ? [] : [approveBody(t, card, approval, shown.merge, act)])
    .children(sendBackBody(t, card, shown.back, approval === null))
}

const logBody = (t: Palette, reading: Reading<string>, scroll: ScrollHandle): Element => {
  if (reading.kind === "failed") return note(t, "log-failed", { tone: "error", title: "Could not read the step's output", body: reading.reason })
  if (reading.kind === "reading") return note(t, "log-reading", { tone: "info", title: "Reading the step's output" })
  if (reading.value === "") return note(t, "log-empty", { tone: "neutral", title: "Nothing written yet" })
  return v_flex().id("log").flex_1().min_h_0().overflow_y_scrollbar().track_scroll(scroll).px(20).py(12)
    .font_family(monospace()).text_size(12)
    .children(logLines(reading.value).map((text) => div().child(text === "" ? " " : text)))
}

const askedLine = (t: Palette, card: Card, act: AgentsActions): ReadonlyArray<Element> =>
  card.standing.status === "Awaiting you" && card.standing.waiting.on === "answer"
    ? [h_flex().px(20).pt(12).gap(8).items_center().text_color(t.muted)
      .child(div().child(`Asked: ${card.where}`))
      .child(button(t, "open-thread", "Open in Thread", "ghost", 24, (cx) => act.choose(cx, { kind: "thread" })))]
    : []

export interface DetailShown {
  readonly reading: Reading<Show> | null
  readonly target: Chosen | null
  readonly merge: MergeOutcome | null
  readonly step: ShownStep | null
  readonly thread: ReadonlyArray<Element>
  readonly back: SendBackShown
  readonly changesProblem: string | null
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

const stepBody = (t: Palette, card: Card, runId: string, step: ShownStep, shown: DetailShown, act: AgentsActions): ReadonlyArray<Element> => {
  if (step.name === "checks") {
    return [div().flex_1().min_h_0().pt(12).child(checksView(t, shown.summary, { of: `${runId}/${step.id.toString()}`, flipped: shown.checks, flip: shown.flipCheck }, shown.checksScroll, () => logBody(t, shown.log, shown.logScroll)))]
  }
  if (opensTurns(step)) {
    return [...(step.status === "running" ? askedLine(t, card, act) : []),
      div().flex_1().min_h_0().child(turnsView(t, shown.turns, { thinking: shown.thinking, calls: shown.calls }, {
        toggleThinking: (turn, cx) => shown.flipThinking(turn, cx),
        toggleCall: (call, cx) => shown.flipCall(call, cx)
      }, shown.turnsScroll, { reading: "Reading the step's Pi session", empty: "No turn yet. Pi writes its session after its first reply." }))]
  }
  return [logBody(t, shown.log, shown.logScroll)]
}

const runBody = (t: Palette, card: Card, shown: DetailShown, act: AgentsActions): ReadonlyArray<Element> => {
  const reading = shown.reading
  if (card.runId === null || reading === null) return [note(t, "no-run", { tone: "neutral", title: "The task has not started a run yet" })]
  if (reading.kind === "reading") return [note(t, "steps-reading", { tone: "info", title: "Reading its steps" })]
  if (reading.kind === "failed") return [note(t, "steps-failed", { tone: "error", title: "Could not read its steps", body: reading.reason })]
  const step = shown.step
  if (step === null) {
    const settled = card.standing.status === "Failed" || card.standing.status === "Done"
    return [note(t, "no-step", { tone: "neutral", title: settled ? "This run ended before it recorded a step" : "No step has started yet" })]
  }
  return stepBody(t, card, card.runId, step, shown, act)
}

const tabBody = (t: Palette, card: Card, shown: DetailShown, act: AgentsActions): ReadonlyArray<Element> => {
  switch (shown.target?.kind) {
    case "thread":
      return [v_flex().id("thread").flex_1().min_h_0().overflow_y_scrollbar().p(20).gap(12).text_size(13).children(shown.thread)]
    case "approve":
      return [approveTab(t, card, shown, act)]
    case "step":
    case undefined:
      return runBody(t, card, shown, act)
  }
}

export const detailView = (t: Palette, card: Card | null, act: AgentsActions, shown: DetailShown): Element => {
  if (card === null) return pane(t, [note(t, "no-run-selected", { tone: "neutral", title: "No run selected" })])
  return pane(t, [
    header(t, card),
    tabRow(t, card, shown.reading, shown.target, act),
    ...(shown.changesProblem === null ? [] : [v_flex().px(20).pt(12).child(alert(t, "changes-problem", { tone: "warning", title: "No Changes column", body: shown.changesProblem }))]),
    ...tabBody(t, card, shown, act)
  ])
}

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
