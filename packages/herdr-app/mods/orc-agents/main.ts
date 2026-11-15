import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { InputState, ScrollHandle, h_flex } from "gpui-base"
import { layout, readTextFile, run, setShared, shared } from "herdr"
import { type Card, type Filter, type RunAgent, buildCards, filterCards, goesOn, runAgent } from "../../src/agents"
import { type AgentsActions, type Chosen, type DetailShown, type Keyed, type Pane, approvalOf, askMerge, detailView, logLines, runsColumn, sendBackBar, stepsColumn, submitSendBack } from "../../src/agents-view"
import { type Merge, mergeCommand, mergedNote, runMerge, watchMerges } from "../../src/agents-merge"
import { type RunChanges, changesKey } from "../../src/changes"
import { readChanges } from "../../src/changes-read"
import { backlog, runs, show, type Show, type ShownStep } from "../../src/guard"
import { type Reading, readJson, readText } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type Turn, sessionTurns } from "../../src/turns"
import { activeChild, agentsOpenKey, openAsk, viewsStack } from "../../src/views"

type Palette = ReturnType<typeof palette>

const everyMs = 4000
const thisView = "orc-agents"
const changesBlock = "orc-changes"
const showsAtOnce = 4

const shown = (): boolean => {
  const active = activeChild(layout(), viewsStack)
  return active === null || active === thisView
}

const readingOf = <A>(keyed: Keyed<A> | null, of: string | null): Reading<A> =>
  of !== null && keyed?.of === of ? keyed.reading : { kind: "reading" }

export default class OrcAgents extends View {
  cards: Reading<ReadonlyArray<Card>> = { kind: "reading" }
  filter: Filter = { project: null, status: null, allRuns: false }
  selectedKey: string | null = null
  chosen: Chosen | null = null
  pane: Pane = "turns"
  opened = 0
  folded = false
  steps: Keyed<Show> | null = null
  log: Keyed<string> | null = null
  shownLines = 0
  turns: Keyed<ReadonlyArray<Turn>> | null = null
  turnsText: string | null = null
  openThinking = new Set<string>()
  openCalls = new Set<string>()
  agents = new Map<string, RunAgent | null>()
  labelling = false
  changesProblem: string | null = null
  sharedChanges: string | null = null
  changesShown: boolean | null = null
  merge: Merge | null = null
  busy = false
  stale = false
  logScroll = ScrollHandle.new()
  turnsScroll = ScrollHandle.new()
  review = InputState.new({ placeholder: "What to change before this PR merges" })
  sent: Keyed<string> | null = null

  override init(_props: unknown, cx: AsyncContext): void {
    this.review.on("submit", (_event, submitted) => this.sendBack(submitted))
    this.review.on("change", (_event, changed) => {
      this.selectedKey = this.selectedCard()?.key ?? null
      changed.notify()
    })
    this.refresh(cx)
    cx.spawn((task) => watchMerges(task, (spot, id) => this.startMerge(spot, id)))
    cx.timer.every(everyMs, (tick) => {
      if (shown()) {
        this.refresh(tick)
      }
    })
  }

  refresh(cx: Context): void {
    if (this.busy) {
      this.stale = true
      return
    }
    this.busy = true
    this.stale = false
    cx.spawn((task) =>
      this.readAll().then(() => {
        this.busy = false
        task.notify()
        this.labelRuns(task)
        if (this.stale) {
          this.refresh(task)
        }
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
      if (this.selectedKey !== null && !this.visibleCards().some((card) => card.key === this.selectedKey) && this.review.value() !== "") {
        this.review.set_value("")
      }
      return Promise.all([this.readSelectedRun(), this.readSelectedChanges()]).then(() => undefined)
    })
  }

  readSelectedRun(): Promise<void> {
    const runId = this.selectedCard()?.runId ?? null
    if (runId === null) {
      this.steps = null
      this.log = null
      this.turns = null
      return Promise.resolve()
    }
    return readJson("orc", ["show", runId, "--json"], show).then((showReading) => {
      this.steps = { of: runId, reading: showReading }
      if (showReading.kind !== "ok") {
        return
      }
      this.agents.set(runId, runAgent(showReading.value.steps))
      const step = this.stepShown()
      if (step === null) {
        return
      }
      const of = `${runId}/${step.id}`
      return this.showsTurns(step) ? this.readTurns(of, step.piSessionFile) : this.readLog(of, runId, step.id)
    })
  }

  readLog(of: string, runId: string, stepId: number): Promise<void> {
    return readText("orc", ["log", runId, stepId.toString()]).then((reading) => {
      const lines = reading.kind === "ok" ? logLines(reading.value).length : 0
      if (this.log?.of !== of || lines !== this.shownLines) {
        this.shownLines = lines
        this.logScroll.scroll_to_item(Math.max(lines - 1, 0))
      }
      this.log = { of, reading }
    })
  }

  readTurns(of: string, file: string | null): Promise<void> {
    if (file === null) {
      this.showTurns(of, "", "")
      return Promise.resolve()
    }
    return readTextFile(file).then(
      (text) => this.showTurns(of, file, text ?? ""),
      () => {
        this.turnsText = null
        this.turns = { of, reading: { kind: "failed", reason: `Cannot read ${file}` } }
      }
    )
  }

  showTurns(of: string, file: string, text: string): void {
    if (this.turns?.of === of && text === this.turnsText) {
      return
    }
    const before = this.turns?.of === of && this.turns.reading.kind === "ok" ? this.turns.reading.value.length : 0
    const parsed = sessionTurns(text)
    this.turnsText = text
    this.turns = { of, reading: parsed.kind === "ok" ? { kind: "ok", value: parsed.value } : { kind: "failed", reason: `${file}: ${parsed.reason}` } }
    if (parsed.kind === "ok" && parsed.value.length > before) {
      this.turnsScroll.scroll_to_item(parsed.value.length - 1)
    }
  }

  readSelectedChanges(): Promise<void> {
    const key = this.selectedCard()?.key ?? null
    const checkout = this.selectedCard()?.checkout ?? null
    const reading: Promise<Reading<RunChanges | null>> = checkout === null ? Promise.resolve({ kind: "ok", value: null }) : readChanges(checkout)
    return reading.then((changes) => {
      if ((this.selectedCard()?.key ?? null) !== key) return
      this.changesProblem = changes.kind === "failed" ? changes.reason : null
      this.shareChanges(changes.kind === "ok" ? changes.value : null)
    })
  }

  // setShared redraws every mod and layout.show moves the columns, so both go out only when the value changed.
  shareChanges(changes: RunChanges | null): void {
    const written = JSON.stringify(changes)
    if (written !== this.sharedChanges) {
      this.sharedChanges = written
      setShared(changesKey, changes)
    }
    const wanted = changes !== null
    if (wanted !== this.changesShown) {
      this.changesShown = wanted
      run(wanted ? "layout.show" : "layout.hide", { id: changesBlock })
    }
  }

  labelRuns(cx: AsyncContext): void {
    const cards = this.cards.kind === "ok" ? this.cards.value : []
    const wanted = cards.flatMap((card) => card.runId !== null && (!this.agents.has(card.runId) || goesOn(card.standing)) ? [card.runId] : [])
    if (this.labelling || wanted.length === 0) {
      return
    }
    this.labelling = true
    const label = (runId: string): Promise<void> =>
      readJson("orc", ["show", runId, "--json"], show).then((reading) => {
        if (reading.kind === "ok") {
          this.agents.set(runId, runAgent(reading.value.steps))
        }
      })
    const from = (start: number, task: AsyncContext): Promise<void> =>
      start >= wanted.length
        ? Promise.resolve()
        : Promise.all(wanted.slice(start, start + showsAtOnce).map(label)).then(() => {
          task.notify()
          return from(start + showsAtOnce, task)
        })
    cx.spawn((task) => from(0, task).then(() => {
      this.labelling = false
    }))
  }

  startMerge(cx: AsyncContext, task: string): void {
    if (this.merge?.outcome.kind === "merging") {
      return
    }
    this.merge = { task, outcome: { kind: "merging" } }
    cx.notify()
    cx.spawn((spot) =>
      runMerge(task).then((problem) => {
        this.merge = problem === null ? null : { task, outcome: { kind: "failed", reason: problem } }
        if (problem === null) {
          mergedNote(task)
        }
        this.refresh(spot)
        spot.notify()
      })
    )
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

  recordedSteps(card: Card): ReadonlyArray<ShownStep> {
    const steps = this.currentSteps(card)
    return steps?.kind === "ok" ? steps.value.steps : []
  }

  target(): Chosen | null {
    const card = this.selectedCard()
    if (card === null) {
      return null
    }
    const approval = approvalOf(card) !== null
    if (this.chosen?.kind === "approve" && approval) {
      return this.chosen
    }
    const ids = this.recordedSteps(card).map((step) => step.id)
    if (this.chosen?.kind === "step" && ids.includes(this.chosen.id)) {
      return this.chosen
    }
    if (approval) {
      return { kind: "approve" }
    }
    const last = ids.at(-1)
    return last === undefined ? null : { kind: "step", id: last }
  }

  stepShown(): ShownStep | null {
    const card = this.selectedCard()
    const target = this.target()
    if (card === null || target?.kind !== "step") {
      return null
    }
    return this.recordedSteps(card).find((step) => step.id === target.id) ?? null
  }

  showsTurns(step: ShownStep): boolean {
    return step.name === "implement" && this.pane === "turns"
  }

  moveSelection(cx: Context, change: () => void): void {
    const before = this.selectedCard()?.key ?? null
    this.chosen = null
    change()
    if ((this.selectedCard()?.key ?? null) !== before) {
      this.changesProblem = null
      this.shareChanges(null)
      this.review.set_value("")
    }
    this.refresh(cx)
    cx.notify()
  }

  select(cx: Context, key: string): void {
    this.moveSelection(cx, () => { this.selectedKey = key })
  }

  choose(cx: Context, chosen: Chosen): void {
    this.moveSelection(cx, () => { this.chosen = chosen })
  }

  setPane(cx: Context, pane: Pane): void {
    this.pane = pane
    this.refresh(cx)
    cx.notify()
  }

  flip(open: Set<string>, id: string, cx: Context): void {
    if (open.has(id)) {
      open.delete(id)
    } else {
      open.add(id)
    }
    cx.notify()
  }

  toggleFold(cx: Context): void {
    this.folded = !this.folded
    cx.notify()
  }

  sendBack(cx: Context): void {
    submitSendBack(this, cx)
  }

  setFilter(cx: Context, filter: Filter): void {
    this.moveSelection(cx, () => { this.filter = filter })
  }

  openAsked(cx: Context): void {
    const asked = openAsk(shared(agentsOpenKey))
    if (asked === null || asked.at === this.opened) return
    this.opened = asked.at
    const askedCard = this.cards.kind === "ok" ? this.cards.value.find((card) => card.key === asked.run) : undefined
    this.filter = { project: null, status: null, allRuns: askedCard?.known === false }
    this.select(cx, asked.run)
    setShared(agentsOpenKey, null)
  }

  render(cx: Context): Element {
    this.openAsked(cx)
    const t = palette()
    const card = this.selectedCard()
    const act: AgentsActions = {
      select: (spot, key) => this.select(spot, key),
      toggleFold: (spot) => this.toggleFold(spot),
      setFilter: (spot, filter) => this.setFilter(spot, filter),
      choose: (spot, chosen) => this.choose(spot, chosen),
      setPane: (spot, pane) => this.setPane(spot, pane),
      askMerge: (asked, approval) => askMerge(asked, approval, `${thisView}.${mergeCommand}${asked.id}`)
    }
    return h_flex().id("root").size_full().bg(t.surface).text_size(13).text_color(t.foreground)
      .child(runsColumn(t, { cards: this.cards, filter: this.filter, selectedKey: card?.key ?? null, agents: this.agents, folded: this.folded }, act))
      .child(stepsColumn(t, card, card === null ? null : this.currentSteps(card), this.target(), this.changesProblem, act))
      .child(this.detail(t, card, act))
  }

  detail(t: Palette, card: Card | null, act: AgentsActions): Element {
    return detailView(t, card, act, this.shownDetail(t, card))
  }

  shownDetail(t: Palette, card: Card | null): DetailShown {
    const step = card === null ? null : this.stepShown()
    const runId = card?.runId ?? null
    const of = step === null || runId === null ? null : `${runId}/${step.id}`
    return {
      target: this.target(),
      merge: card === null ? null : this.merge?.task === card.id ? this.merge.outcome : null,
      step,
      steps: card === null ? [] : this.recordedSteps(card),
      back: card === null ? [] : sendBackBar(t, card, this.review, this.sent?.of === card.key ? this.sent.reading : null, (cx) => this.sendBack(cx)),
      pane: this.pane,
      turns: readingOf(this.turns, of),
      log: readingOf(this.log, of),
      thinking: this.openThinking,
      calls: this.openCalls,
      turnsScroll: this.turnsScroll,
      logScroll: this.logScroll,
      flipThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
      flipCall: (call, cx) => this.flip(this.openCalls, call, cx)
    }
  }
}
