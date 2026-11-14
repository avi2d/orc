import { type AsyncContext, type Color, type Context, type Element, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { layout, settings } from "herdr"
import { type Card, type CardStatus, type Filter, type Mark, type StepRow, buildCards, cardStatuses, filterCards, projectsOf, railLabel, stepRows } from "../../src/agents"
import { backlog, runs, show, type Show } from "../../src/guard"
import { type Reading, readJson, readText } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { activeChild, viewsStack } from "../../src/views"

interface Keyed<A> {
  readonly of: string
  readonly reading: Reading<A>
}

type Palette = ReturnType<typeof palette>

const everyMs = 4000
const thisView = "orc-agents"

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

const logLines = (text: string): ReadonlyArray<string> =>
  text.replace(escapeSequence, "").replace(/\n$/, "").split("\n")

const monospace = (): string => {
  const family = settings()["font_family"]
  return typeof family === "string" ? family : "Menlo"
}

const shown = (): boolean => {
  const active = activeChild(layout(), viewsStack)
  return active === null || active === thisView
}

export default class OrcAgents extends View {
  cards: Reading<ReadonlyArray<Card>> = { kind: "reading" }
  filter: Filter = { project: null, status: null }
  selectedKey: string | null = null
  chosenStep: number | null = null
  folded = false
  steps: Keyed<Show> | null = null
  log: Keyed<string> | null = null
  shownLines = 0
  busy = false
  logScroll = ScrollHandle.new()

  override init(_props: unknown, cx: AsyncContext): void {
    this.refresh(cx)
    cx.timer.every(everyMs, (tick) => {
      if (shown()) {
        this.refresh(tick)
      }
    })
  }

  refresh(cx: Context): void {
    if (this.busy) {
      return
    }
    this.busy = true
    cx.spawn((task) =>
      this.readAll().then(() => {
        this.busy = false
        task.notify()
      })
    )
  }

  readAll(): Promise<void> {
    return Promise.all([
      readJson("orc", ["runs", "--json", "--local"], runs),
      readJson("orc", ["backlog", "--json"], backlog)
    ]).then(([runsReading, backlogReading]) => {
      this.cards = runsReading.kind !== "ok"
        ? runsReading
        : backlogReading.kind !== "ok"
        ? backlogReading
        : { kind: "ok", value: buildCards(runsReading.value, backlogReading.value) }
      const runId = this.selectedCard()?.runId ?? null
      if (runId === null) {
        this.steps = null
        this.log = null
        return
      }
      return readJson("orc", ["show", runId, "--json"], show).then((showReading) => {
        this.steps = { of: runId, reading: showReading }
        const stepId = this.stepShown()
        if (stepId === null) {
          this.log = null
          return
        }
        return readText("orc", ["log", runId, stepId.toString()]).then((reading) => {
          const of = `${runId}/${stepId}`
          const lines = reading.kind === "ok" ? logLines(reading.value).length : 0
          if (this.log?.of !== of || lines !== this.shownLines) {
            this.shownLines = lines
            this.logScroll.scroll_to_item(Math.max(lines - 1, 0))
          }
          this.log = { of, reading }
        })
      })
    })
  }

  visibleCards(): ReadonlyArray<Card> {
    return this.cards.kind === "ok" ? filterCards(this.cards.value, this.filter) : []
  }

  selectedCard(): Card | null {
    const cards = this.visibleCards()
    return cards.find((card) => card.key === this.selectedKey) ?? cards.at(0) ?? null
  }

  currentSteps(card: Card): Reading<Show> | null {
    if (card.runId === null) {
      return null
    }
    return this.steps?.of === card.runId ? this.steps.reading : { kind: "reading" }
  }

  stepShown(): number | null {
    const card = this.selectedCard()
    const steps = card === null ? null : this.currentSteps(card)
    if (steps?.kind !== "ok") {
      return null
    }
    const ids = steps.value.steps.map((step) => step.id)
    return this.chosenStep !== null && ids.includes(this.chosenStep) ? this.chosenStep : ids.at(-1) ?? null
  }

  select(cx: Context, key: string): void {
    this.selectedKey = key
    this.chosenStep = null
    this.refresh(cx)
    cx.notify()
  }

  chooseStep(cx: Context, stepId: number): void {
    this.chosenStep = stepId
    this.refresh(cx)
    cx.notify()
  }

  toggleFold(cx: Context): void {
    this.folded = !this.folded
    cx.notify()
  }

  setFilter(cx: Context, filter: Filter): void {
    this.filter = filter
    this.chosenStep = null
    this.refresh(cx)
    cx.notify()
  }

  render(): Element {
    const t = palette()
    const card = this.selectedCard()
    return h_flex().id("root").size_full().bg(t.surface).text_size(13).text_color(t.foreground)
      .child(this.folded ? this.rail(t, card) : this.list(t, card))
      .child(this.stepsColumn(t, card))
      .child(this.detail(t, card))
  }

  chip(t: Palette, id: string, label: string, on: boolean, pick: (cx: Context) => void): Element {
    return div().id(id).px(8).py(2).rounded(4).cursor_pointer()
      .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
      .hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => pick(cx))
      .child(label)
  }

  filters(t: Palette): Element {
    const all = this.cards.kind === "ok" ? this.cards.value : []
    const byProject = filterCards(all, { project: this.filter.project, status: null })
    const projects = projectsOf(all)
    return v_flex().gap(6).px(12).pb(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(4).flex_wrap().items_center()
        .child(div().w(52).text_color(t.dim).child("Project"))
        .child(this.chip(t, "project-all", "All", this.filter.project === null, (cx) => this.setFilter(cx, { ...this.filter, project: null })))
        .children(projects.map((project) =>
          this.chip(t, `project-${project}`, project, this.filter.project === project, (cx) => this.setFilter(cx, { ...this.filter, project })))))
      .child(h_flex().gap(4).flex_wrap().items_center()
        .child(div().w(52).text_color(t.dim).child("Status"))
        .child(this.chip(t, "status-all", "All", this.filter.status === null, (cx) => this.setFilter(cx, { ...this.filter, status: null })))
        .children(cardStatuses.map((status) => {
          const count = byProject.filter((entry) => entry.standing.status === status).length
          return this.chip(t, `status-${status}`, `${status} ${count}`, this.filter.status === status, (cx) => this.setFilter(cx, { ...this.filter, status }))
        })))
  }

  list(t: Palette, selected: Card | null): Element {
    const cards = this.visibleCards()
    const body = this.cards.kind === "failed"
      ? div().p(12).text_color(t.blocked).child(this.cards.reason)
      : this.cards.kind === "reading"
      ? div().p(12).text_color(t.muted).child("Reading orc runs --json --local")
      : cards.length === 0
      ? div().p(12).text_color(t.muted).child("No run matches these filters")
      : v_flex().id("cards").flex_1().overflow_y_scrollbar().px(8).py(8).gap(6)
        .children(cards.map((card) => this.cardView(t, card, card.key === selected?.key)))
    return v_flex().w(380).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().px(12).h(44).items_center().justify_between()
        .child(div().text_size(15).font_semibold().child("Runs"))
        .child(this.foldButton(t, "fold", "«")))
      .child(this.filters(t))
      .child(body)
  }

  cardView(t: Palette, card: Card, selected: boolean): Element {
    const color = statusColor(t, card.standing.status)
    return v_flex().id(`card-${card.key}`).p(10).gap(3).rounded(6).cursor_pointer().border_l(3).border_color(color)
      .bg(selected ? t.selected : t.background)
      .hover((style) => style.bg(selected ? t.selected : t.hover))
      .on_click((_event, cx) => this.select(cx, card.key))
      .child(h_flex().justify_between().gap(8)
        .child(h_flex().gap(6).min_w_0()
          .child(div().font_semibold().truncate().child(card.id))
          .children(card.kind === null ? [] : [div().text_color(t.dim).flex_shrink_0().child(card.kind)]))
        .child(div().flex_shrink_0().text_size(12).text_color(color).child(card.standing.status)))
      .child(div().truncate().child(card.title))
      .child(div().truncate().text_color(t.muted).child(card.where))
  }

  foldButton(t: Palette, id: string, label: string): Element {
    return div().id(id).px(8).py(2).rounded(4).cursor_pointer().text_size(15).text_color(t.muted)
      .hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.toggleFold(cx))
      .child(label)
  }

  rail(t: Palette, selected: Card | null): Element {
    return v_flex().id("rail").w(96).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().h(44).px(8).items_center().child(this.foldButton(t, "unfold", "»")))
      .child(v_flex().id("rail-ids").flex_1().overflow_y_scrollbar().px(6).gap(2)
        .children(this.visibleCards().map((card) =>
          div().id(`rail-${card.key}`).px(6).py(3).rounded(4).cursor_pointer().truncate()
            .text_color(statusColor(t, card.standing.status))
            .bg(card.key === selected?.key ? t.selected : t.chrome)
            .hover((style) => style.bg(t.hover))
            .on_click((_event, cx) => this.select(cx, card.key))
            .child(railLabel(card)))))
  }

  stepsColumn(t: Palette, card: Card | null): Element {
    const column = v_flex().w(240).h_full().flex_shrink_0().border_r(1).border_color(t.border)
    if (card === null) {
      return column
    }
    const reading = this.currentSteps(card)
    const header = v_flex().px(12).py(10).gap(2).border_b(1).border_color(t.border)
      .child(div().font_semibold().truncate().child(card.title))
      .child(div().text_size(12).text_color(t.dim).truncate().child(card.runId ?? "No run yet"))
    if (reading?.kind === "failed") {
      return column.child(header).child(div().p(12).text_color(t.blocked).child(reading.reason))
    }
    if (reading?.kind === "reading") {
      return column.child(header).child(div().p(12).text_color(t.muted).child("Reading its steps"))
    }
    const shownStep = this.stepShown()
    const rows = stepRows(card.standing, reading?.value.steps ?? [], card.kind, card.delivery)
    return column.child(header)
      .child(v_flex().id("steps").flex_1().overflow_y_scrollbar().p(6).gap(2)
        .children(rows.map((row) => this.rowView(t, row, row.stepId !== null && row.stepId === shownStep))))
  }

  rowView(t: Palette, row: StepRow, selected: boolean): Element {
    const line = h_flex().id(`row-${row.key}`).px(8).py(4).gap(8).rounded(4).items_center()
      .bg(selected ? t.selected : t.surface)
      .child(div().w(14).text_color(markColor(t, row.mark)).child(row.mark))
      .child(div().text_color(row.stepId === null ? t.muted : t.foreground).child(row.label))
    const stepId = row.stepId
    return stepId === null
      ? line
      : line.cursor_pointer().hover((style) => style.bg(selected ? t.selected : t.hover)).on_click((_event, cx) => this.chooseStep(cx, stepId))
  }

  detail(t: Palette, card: Card | null): Element {
    const pane = v_flex().flex_1().min_w_0().h_full().bg(t.background)
    if (card === null) {
      return pane.child(div().p(16).text_color(t.muted).child("No run selected"))
    }
    const runId = card.runId
    const stepId = this.stepShown()
    if (runId === null) {
      return pane.child(div().p(16).text_color(t.muted).child("The task has not started a run yet"))
    }
    if (stepId === null) {
      const settled = card.standing.status === "Failed" || card.standing.status === "Done"
      return pane.child(div().p(16).text_color(t.muted).child(settled ? "This run ended before it recorded a step" : "No step has started yet"))
    }
    const reading = this.log?.of === `${runId}/${stepId}` ? this.log.reading : { kind: "reading" as const }
    const header = h_flex().px(16).h(40).flex_shrink_0().items_center().justify_between().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(this.stepTitle(card, stepId)))
      .child(div().text_size(12).text_color(t.dim).child(`orc log ${runId} ${stepId}`))
    const body = reading.kind === "failed"
      ? div().p(16).text_color(t.blocked).child(reading.reason)
      : reading.kind === "reading"
      ? div().p(16).text_color(t.muted).child("Reading the step's output")
      : reading.value === ""
      ? div().p(16).text_color(t.muted).child("Nothing written yet")
      : v_flex().id("log").flex_1().overflow_y_scrollbar().track_scroll(this.logScroll).px(16).py(10)
        .font_family(monospace()).text_size(12)
        .children(logLines(reading.value).map((text) => div().child(text === "" ? " " : text)))
    return pane.child(header).child(body)
  }

  stepTitle(card: Card, stepId: number): string {
    const steps = this.currentSteps(card)
    const row = steps?.kind === "ok" ? stepRows(card.standing, steps.value.steps, card.kind, card.delivery).find((entry) => entry.stepId === stepId) : undefined
    return row?.label ?? "Step"
  }
}
