import { type Color, type Context, type Element, div } from "gpui-kit"
import { Input, type InputState, type ScrollHandle, h_flex, v_flex } from "gpui-base"
import { openOverlay, settings } from "herdr"
import { type Card, type CardStatus, type Filter, type Mark, type RunAgent, type StepRow, agentLabel, approveRow, cardPlace, cardStatuses, filterCards, namedModels, opensTurns, projectsOf, railLabel, sendBackArgs, stepRows } from "./agents"
import type { Show, ShownStep } from "./guard"
import { linkedText } from "./links-view"
import { type Reading, readText } from "./orc-read"
import type { palette } from "./palette"
import { type Turn } from "./turns"
import { turnsView } from "./turns-view"

type Palette = ReturnType<typeof palette>

export type Chosen = { readonly kind: "step"; readonly id: number } | { readonly kind: "approve" }

export type Pane = "turns" | "raw"

export interface Approval {
  readonly pr: string
  readonly link: string
}

export type MergeOutcome = { readonly kind: "merging" } | { readonly kind: "failed"; readonly reason: string }

export interface AgentsActions {
  readonly select: (cx: Context, key: string) => void
  readonly toggleFold: (cx: Context) => void
  readonly setFilter: (cx: Context, filter: Filter) => void
  readonly choose: (cx: Context, chosen: Chosen) => void
  readonly setPane: (cx: Context, pane: Pane) => void
  readonly askMerge: (card: Card, approval: Approval) => void
}

export interface RunsShown {
  readonly cards: Reading<ReadonlyArray<Card>>
  readonly filter: Filter
  readonly selectedKey: string | null
  readonly agents: ReadonlyMap<string, RunAgent | null>
  readonly folded: boolean
}

export const approvalOf = (card: Card): Approval | null =>
  card.standing.status === "Awaiting you" && card.standing.waiting.on === "approval" ? card.standing.waiting : null

const statusColor = (t: Palette, status: CardStatus): Color => {
  switch (status) {
    case "Awaiting you":
      return t.blocked
    case "Running":
      return t.working
    case "Queued":
      return t.muted
    case "Failed":
      return t.ansi1
    case "Done":
      return t.done
  }
}

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

const escapeSequence = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g")

export const logLines = (text: string): ReadonlyArray<string> =>
  text.replace(escapeSequence, "").replace(/\n$/, "").split("\n")

const monospace = (): string => {
  const family = settings()["font_family"]
  return typeof family === "string" ? family : "Menlo"
}

const chip = (t: Palette, id: string, label: string, on: boolean, pick: (cx: Context) => void): Element =>
  div().id(id).px(8).py(2).rounded(4).cursor_pointer()
    .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => pick(cx))
    .child(label)

const filters = (t: Palette, all: ReadonlyArray<Card>, filter: Filter, act: AgentsActions): Element => {
  const byProject = filterCards(all, { project: filter.project, status: null })
  return v_flex().gap(6).px(12).pb(8).border_b(1).border_color(t.border)
    .child(h_flex().gap(4).flex_wrap().items_center()
      .child(div().w(52).text_color(t.dim).child("Project"))
      .child(chip(t, "project-all", "All", filter.project === null, (cx) => act.setFilter(cx, { ...filter, project: null })))
      .children(projectsOf(all).map((project) =>
        chip(t, `project-${project}`, project, filter.project === project, (cx) => act.setFilter(cx, { ...filter, project })))))
    .child(h_flex().gap(4).flex_wrap().items_center()
      .child(div().w(52).text_color(t.dim).child("Status"))
      .child(chip(t, "status-all", "All", filter.status === null, (cx) => act.setFilter(cx, { ...filter, status: null })))
      .children(cardStatuses.map((status) => {
        const count = byProject.filter((entry) => entry.standing.status === status).length
        return chip(t, `status-${status}`, `${status} ${count}`, filter.status === status, (cx) => act.setFilter(cx, { ...filter, status }))
      })))
}

const cardView = (t: Palette, card: Card, selected: boolean, agent: RunAgent | null, act: AgentsActions): Element => {
  const color = statusColor(t, card.standing.status)
  return v_flex().id(`card-${card.key}`).p(10).gap(3).rounded(6).cursor_pointer().border_l(3).border_color(color)
    .bg(selected ? t.selected : t.background)
    .hover((style) => style.bg(selected ? t.selected : t.hover))
    .on_click((_event, cx) => act.select(cx, card.key))
    .child(h_flex().justify_between().gap(8)
      .child(h_flex().gap(6).min_w_0()
        .child(div().font_semibold().truncate().child(card.id))
        .children(card.kind === null ? [] : [div().text_color(t.dim).flex_shrink_0().child(card.kind)]))
      .child(div().flex_shrink_0().text_size(12).text_color(color).child(card.standing.status)))
    .child(div().truncate().child(card.title))
    .child(div().truncate().text_color(t.muted).child(cardPlace(card, agent)))
}

const foldButton = (t: Palette, id: string, label: string, act: AgentsActions): Element =>
  div().id(id).px(8).py(2).rounded(4).cursor_pointer().text_size(15).text_color(t.muted)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => act.toggleFold(cx))
    .child(label)

const listBody = (t: Palette, shown: RunsShown, visible: ReadonlyArray<Card>, act: AgentsActions): Element => {
  if (shown.cards.kind === "failed") {
    return div().p(12).text_color(t.blocked).child(shown.cards.reason)
  }
  if (shown.cards.kind === "reading") {
    return div().p(12).text_color(t.muted).child("Reading orc runs --json --local")
  }
  if (visible.length === 0) {
    return div().p(12).text_color(t.muted).child("No run matches these filters")
  }
  return v_flex().id("cards").flex_1().overflow_y_scrollbar().px(8).py(8).gap(6)
    .children(visible.map((card) =>
      cardView(t, card, card.key === shown.selectedKey, card.runId === null ? null : shown.agents.get(card.runId) ?? null, act)))
}

const rail = (t: Palette, shown: RunsShown, visible: ReadonlyArray<Card>, act: AgentsActions): Element =>
  v_flex().id("rail").w(96).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
    .child(h_flex().h(44).px(8).items_center().child(foldButton(t, "unfold", "»", act)))
    .child(v_flex().id("rail-ids").flex_1().overflow_y_scrollbar().px(6).gap(2)
      .children(visible.map((card) =>
        div().id(`rail-${card.key}`).px(6).py(3).rounded(4).cursor_pointer().truncate()
          .text_color(statusColor(t, card.standing.status))
          .bg(card.key === shown.selectedKey ? t.selected : t.chrome)
          .hover((style) => style.bg(t.hover))
          .on_click((_event, cx) => act.select(cx, card.key))
          .child(railLabel(card)))))

export const runsColumn = (t: Palette, shown: RunsShown, act: AgentsActions): Element => {
  const all = shown.cards.kind === "ok" ? shown.cards.value : []
  const visible = filterCards(all, shown.filter)
  if (shown.folded) {
    return rail(t, shown, visible, act)
  }
  return v_flex().w(380).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
    .child(h_flex().px(12).h(44).items_center().justify_between()
      .child(div().text_size(15).font_semibold().child("Runs"))
      .child(foldButton(t, "fold", "«", act)))
    .child(filters(t, all, shown.filter, act))
    .child(listBody(t, shown, visible, act))
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

export const stepsColumn = (t: Palette, card: Card | null, reading: Reading<Show> | null, target: Chosen | null, changesProblem: string | null, act: AgentsActions): Element => {
  const column = v_flex().w(240).h_full().flex_shrink_0().border_r(1).border_color(t.border)
  if (card === null) {
    return column
  }
  const header = v_flex().px(12).py(10).gap(2).border_b(1).border_color(t.border)
    .child(div().font_semibold().truncate().child(card.title))
    .child(div().text_size(12).text_color(t.dim).truncate().child(card.runId ?? "No run yet"))
  if (reading?.kind === "failed") {
    return column.child(header).child(div().p(12).text_color(t.blocked).child(reading.reason))
  }
  if (reading?.kind === "reading") {
    return column.child(header).child(div().p(12).text_color(t.muted).child("Reading its steps"))
  }
  const steps = reading?.value.steps ?? []
  const models = namedModels(steps)
  return column.child(header)
    .child(v_flex().id("steps").flex_1().overflow_y_scrollbar().p(6).gap(2)
      .children(stepRows(card.standing, steps, card.kind, card.delivery).map((row) =>
        rowView(t, row, target, row.stepId === null ? null : models.get(row.stepId) ?? null, act))))
    .children(changesProblem === null ? [] : [div().px(12).py(8).border_t(1).border_color(t.border).text_size(12).text_color(t.blocked).child(`No Changes column: ${changesProblem}`)])
}

const paneChoice = (t: Palette, pane: Pane, label: string, on: boolean, act: AgentsActions): Element =>
  div().id(`pane-${pane}`).px(10).py(2).rounded(4).cursor_pointer()
    .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => act.setPane(cx, pane))
    .child(label)

const stepBar = (t: Palette, step: ShownStep, title: string, source: string, pane: Pane, act: AgentsActions): Element => {
  const agent = agentLabel({ model: step.model, effort: step.thinking })
  return h_flex().px(16).h(40).gap(12).flex_shrink_0().items_center().border_b(1).border_color(t.border)
    .child(div().flex_shrink_0().font_semibold().child(title))
    .children(agent === null ? [] : [div().flex_shrink_0().text_size(12).text_color(t.muted).child(agent)])
    .children(opensTurns(step)
      ? [h_flex().gap(2).flex_shrink_0().child(paneChoice(t, "turns", "Turns", pane === "turns", act)).child(paneChoice(t, "raw", "Raw", pane === "raw", act))]
      : [])
    .child(div().flex_1().min_w_0().truncate().text_right().text_size(12).text_color(t.dim).child(source))
}

const detailPane = (t: Palette, parts: ReadonlyArray<Element>): Element =>
  v_flex().flex_1().min_w_0().h_full().bg(t.background).children(parts)

const detailNote = (t: Palette, text: string): Element =>
  detailPane(t, [div().p(16).text_color(t.muted).child(text)])

const approvePane = (t: Palette, card: Card, approval: Approval, merge: MergeOutcome | null, act: AgentsActions): Element => {
  const merging = merge?.kind === "merging"
  const button = h_flex().id("approve-merge").h(32).px(14).items_center().rounded(8).text_size(13)
    .bg(merging ? t.raised : t.solid).text_color(merging ? t.dim : t.solid_foreground)
    .child(merging ? "Merging" : "Approve and merge")
  return detailPane(t, [
    h_flex().px(16).h(40).flex_shrink_0().items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(`Approve ${approval.pr}`)),
    v_flex().p(16).gap(12).items_start()
      .child(div().child(card.title))
      .child(div().text_color(t.muted).child(linkedText(`approve-${card.key}`, approval.link)))
      .child(div().text_color(t.muted).child(`The run passed and ${approval.pr} waits for your word. Merging runs orc merge ${card.id} --basis captain-word.`))
      .child(merging ? button : button.cursor_pointer().hover((style) => style.opacity(0.88)).on_click(() => act.askMerge(card, approval)))
      .children(merge?.kind === "failed" ? [div().text_color(t.ansi1).child(merge.reason)] : [])
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

export const askMerge = (card: Card, approval: Approval, command: string): void => {
  openOverlay({
    mod: "confirm",
    kind: "dialog",
    width: 440,
    height: 190,
    props: {
      title: `Merge ${approval.pr}?`,
      detail: `orc merge ${card.id} --basis captain-word squashes ${approval.pr} into its base branch.`,
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
  readonly thinking: ReadonlySet<string>
  readonly calls: ReadonlySet<string>
  readonly turnsScroll: ScrollHandle
  readonly logScroll: ScrollHandle
  readonly flipThinking: (turn: string, cx: Context) => void
  readonly flipCall: (call: string, cx: Context) => void
}

export const detailView = (t: Palette, card: Card | null, act: AgentsActions, shown: DetailShown): Element => {
  if (card === null) {
    return detailNote(t, "No run selected")
  }
  if (card.runId === null) {
    return detailNote(t, "The task has not started a run yet")
  }
  const approval = approvalOf(card)
  if (approval !== null && shown.target?.kind === "approve") {
    const pane = approvePane(t, card, approval, shown.merge, act)
    return shown.back.length === 0 ? pane : detailPane(t, [...shown.back, pane])
  }
  const step = shown.step
  if (step === null) {
    const settled = card.standing.status === "Failed" || card.standing.status === "Done"
    return detailNote(t, settled ? "This run ended before it recorded a step" : "No step has started yet")
  }
  const title = stepTitle(card, shown.steps, step.id)
  if (opensTurns(step) && shown.pane === "turns") {
    return detailPane(t, [...shown.back, stepBar(t, step, title, "Pi session", shown.pane, act),
      div().flex_1().min_h_0().child(turnsView(t, shown.turns, { thinking: shown.thinking, calls: shown.calls }, {
        toggleThinking: (turn, cx) => shown.flipThinking(turn, cx),
        toggleCall: (call, cx) => shown.flipCall(call, cx)
      }, shown.turnsScroll, { reading: "Reading the step's Pi session", empty: "No turn yet. Pi writes its session after its first reply." }))])
  }
  return detailPane(t, [...shown.back, stepBar(t, step, title, `orc log ${card.runId} ${step.id}`, shown.pane, act), logBody(t, shown.log, shown.logScroll)])
}
