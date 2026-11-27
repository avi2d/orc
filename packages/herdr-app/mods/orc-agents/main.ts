import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { InputState, h_flex } from "gpui-base"
import { layout, run, setShared, shared } from "herdr"
import { AgentAttentionSection } from "../../src/agent-attention-view"
import type { AgentAttention } from "../../src/inbox-read"
import { type Card, type CardStatus, type Filter, approvalOf, cardAttention, filterCards, goesOn, openedFilter, recordedStatus, unfoldedCards } from "../../src/agents"
import { type RunFacts, runFacts } from "../../src/run-agent"
import { type LocalAgents, agentsDocuments, readAgentQuestions, readLocalAgents } from "../../src/agents-read"
import type { AttentionQueue } from "../../src/guard-attention"
import { type AgentsActions, type Chosen, type DetailShown, type Keyed, askMerge, detailView, submitSendBack } from "../../src/agents-view"
import { type ListReading, type Reread, runsColumn } from "../../src/runs-view"
import { type Merge, mergeCommand, mergedNote, runMerge, watchMerges } from "../../src/agents-merge"
import { type RunChanges, changesKey } from "../../src/changes"
import { readChanges } from "../../src/changes-read"
import { show, type Show, type ShownStep } from "../../src/guard"
import { InboxAnswers, threadBoxes } from "../../src/inbox-view"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { StepOutput } from "../../src/step-output"
import { thread } from "../../src/task-guard"
import type { Thread } from "../../src/thread"
import { targetOf } from "../../src/agents-target"
import { threadShown } from "../../src/agents-thread"
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
  list: ListReading = { kind: "reading" }
  filter: Filter = { project: null, allRuns: false }
  find = InputState.new({ placeholder: "Find a run" })
  menuOpen = false
  selectedKey: string | null = null
  chosen: Chosen | null = null
  opened = 0
  folded = false
  foldedGroups = new Set<CardStatus>()
  steps: Keyed<Show> | null = null
  told: Keyed<Thread> | null = null
  output = new StepOutput()
  openThinking = new Set<string>()
  openCalls = new Set<string>()
  flippedChecks = new Set<string>()
  facts = new Map<string, RunFacts | null>()
  labelling = false
  changesProblem: string | null = null
  sharedChanges: string | null = null
  changesShown: boolean | null = null
  merge: Merge | null = null
  busy = false
  stale = false
  questionsBusy = false
  questions: AttentionQueue = { items: [], decided: [] }
  local: LocalAgents | null = null
  listed = new Date().toISOString()
  review = InputState.new({ placeholder: "What to change before this PR merges" })
  sent: Keyed<string> | null = null
  answers = new InboxAnswers((cx) => this.refresh(cx), threadBoxes)
  agent: AgentAttention = { pending: [], decided: [] }
  agentAttention = new AgentAttentionSection()

  override init(_props: unknown, cx: AsyncContext): void {
    this.review.on("submit", (_event, submitted) => this.sendBack(submitted))
    this.review.on("change", (_event, changed) => {
      this.selectedKey = this.selectedCard()?.key ?? null
      changed.notify()
    })
    this.find.on("change", (_event, changed) => this.moveSelection(changed, () => undefined, this.selectedKey))
    this.refresh(cx)
    cx.spawn((task) => watchMerges(task, (spot, id) => this.startMerge(spot, id)))
    cx.timer.every(everyMs, (tick) => {
      if (shown()) {
        this.refresh(tick)
      }
    })
  }

  refresh(cx: Context): void {
    this.refreshQuestions(cx)
    if (this.busy) {
      this.stale = true
      return
    }
    this.busy = true
    this.stale = false
    cx.spawn((task) =>
      this.readAll(task).then(() => {
        this.busy = false
        task.notify()
        this.labelRuns(task)
        if (this.stale) {
          this.refresh(task)
        }
      })
    )
  }

  refreshQuestions(cx: Context): void {
    if (this.questionsBusy) return
    this.questionsBusy = true
    cx.spawn((task) => readAgentQuestions().then((reading) => {
      this.questionsBusy = false
      if (reading.kind === "ok") {
        this.questions = reading.value
        this.showCards(task, this.list.kind === "ok" ? this.list.reread : null)
      }
      task.notify()
    }))
  }

  showCards(cx: Context, reread: Reread | null): void {
    if (this.local === null) return
    const documents = agentsDocuments(this.local, this.questions)
    this.list = { kind: "ok", cards: documents.cards, reread }
    this.agent = documents.agent
    this.answers.sync(cx, documents.cards.flatMap(cardAttention))
  }

  readAll(cx: Context): Promise<void> {
    return readLocalAgents().then((reading) => {
      if (reading.kind === "ok") {
        this.local = reading.value
        this.listed = new Date().toISOString()
        this.showCards(cx, null)
      } else if (this.list.kind === "ok") {
        this.list = { ...this.list, reread: reading.kind === "failed" ? { reason: reading.reason, listed: this.listed } : null }
      } else {
        this.local = null
        this.list = reading
      }
      cx.notify()
      if (this.selectedKey !== null && !this.visibleCards().some((card) => card.key === this.selectedKey) && this.review.value() !== "") {
        this.review.set_value("")
      }
      return Promise.all([this.readSelectedRun(), this.readSelectedThread(), this.readSelectedChanges()]).then(() => undefined)
    })
  }

  readSelectedThread(): Promise<void> {
    const card = this.selectedCard()
    const task = card === null ? undefined : this.local?.details.find((detail) => detail.id === card.id)
    if (card === null || task === undefined) {
      this.told = null
      return Promise.resolve()
    }
    return readJson("orc", ["backlog", "thread", task.id, "--json"], thread).then((reading) => {
      if (this.selectedCard()?.id === task.id) this.told = { of: task.id, reading }
    })
  }

  readSelectedRun(): Promise<void> {
    const runId = this.selectedCard()?.runId ?? null
    if (runId === null) {
      this.steps = null
      this.output = new StepOutput()
      return Promise.resolve()
    }
    return readJson("orc", ["show", runId, "--json"], show).then((showReading) => {
      this.steps = { of: runId, reading: showReading }
      const card = this.selectedCard()
      if (showReading.kind !== "ok" || card?.runId !== runId) return
      this.facts.set(runId, runFacts(showReading.value))
      const step = this.stepShown()
      if (step === null) return
      const of = `${runId}/${step.id}`
      const status = recordedStatus(step.status, card.standing.status)
      return this.output.read(of, runId, { ...step, status }, showReading.value.taskFile)
    })
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

  allCards(): ReadonlyArray<Card> {
    return this.list.kind === "ok" ? this.list.cards : []
  }

  labelRuns(cx: AsyncContext): void {
    const wanted = this.allCards().flatMap((card) => card.runId !== null && (!this.facts.has(card.runId) || goesOn(card.standing)) ? [card.runId] : [])
    if (this.labelling || wanted.length === 0) {
      return
    }
    this.labelling = true
    const label = (runId: string): Promise<void> =>
      readJson("orc", ["show", runId, "--json"], show).then((reading) => {
        if (reading.kind === "ok") {
          this.facts.set(runId, runFacts(reading.value))
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
    const approval = this.allCards().map(approvalOf).find((item) => item?.task === task)
    if (approval === undefined || approval === null || this.answers.busy(approval.key)) return
    this.answers.sent.set(approval.key, { kind: "sending" })
    this.merge = { task, outcome: { kind: "merging" } }
    cx.notify()
    cx.spawn((spot) =>
      runMerge(task).then((problem) => {
        this.merge = problem === null ? null : { task, outcome: { kind: "failed", reason: problem } }
        if (problem === null) {
          this.answers.sent.delete(approval.key)
          this.answers.recorded.add(approval.key)
          mergedNote(task)
        } else {
          this.answers.sent.set(approval.key, { kind: "failed", reason: problem })
        }
        this.refresh(spot)
        spot.notify()
      })
    )
  }

  visibleCards(): ReadonlyArray<Card> {
    const words = this.find.value()
    return unfoldedCards(filterCards(this.allCards(), this.filter, words), this.foldedGroups)
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
    return card === null ? null : targetOf(card, this.chosen, this.recordedSteps(card))
  }

  stepShown(): ShownStep | null {
    const card = this.selectedCard()
    const target = this.target()
    if (card === null || target?.kind !== "step") {
      return null
    }
    return this.recordedSteps(card).find((step) => step.id === target.id) ?? null
  }

  moveSelection(cx: Context, change: () => void, before: string | null = this.selectedCard()?.key ?? null): void {
    this.chosen = null
    this.menuOpen = false
    change()
    this.selectedKey = this.selectedCard()?.key ?? null
    if (before === null || this.selectedKey !== before) {
      this.changesProblem = null
      this.told = null
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
    const key = this.selectedCard()?.key ?? null
    this.moveSelection(cx, () => {
      this.selectedKey = key
      this.chosen = chosen
    })
  }

  flip<A>(open: Set<A>, id: A, cx: Context): void {
    if (open.has(id)) {
      open.delete(id)
    } else {
      open.add(id)
    }
    cx.notify()
  }

  sendBack(cx: Context): void {
    submitSendBack(this, cx)
  }

  openAsked(cx: Context): void {
    const asked = openAsk(shared(agentsOpenKey))
    if (asked === null || asked.at === this.opened || this.list.kind !== "ok") return
    this.opened = asked.at
    this.moveSelection(cx, () => {
      this.filter = openedFilter(this.allCards(), asked.run)
      this.find.set_value("")
      this.foldedGroups.clear()
      this.selectedKey = asked.run
    })
    setShared(agentsOpenKey, null)
  }

  render(cx: Context): Element {
    this.openAsked(cx)
    const t = palette()
    const card = this.selectedCard()
    const act: AgentsActions = {
      select: (spot, key) => this.select(spot, key),
      toggleFold: (spot) => { this.folded = !this.folded; this.menuOpen = false; spot.notify() },
      toggleGroup: (spot, status) => this.moveSelection(spot, () => this.flip(this.foldedGroups, status, spot)),
      setFilter: (spot, filter) => this.moveSelection(spot, () => { this.filter = filter }),
      openMenu: (spot, open) => { this.menuOpen = open; spot.notify() },
      clearFind: (spot) => this.moveSelection(spot, () => this.find.set_value("")),
      retry: (spot) => this.refresh(spot),
      choose: (spot, chosen) => this.choose(spot, chosen),
      askMerge: (asked, approval) => askMerge(approval, `${thisView}.${mergeCommand}${asked.id}`)
    }
    return h_flex().id("root").size_full().bg(t.surface).text_size(13).text_color(t.foreground)
      .child(runsColumn(t, {
        list: this.list, filter: this.filter, find: this.find, menuOpen: this.menuOpen, selectedKey: card?.key ?? null,
        facts: this.facts, now: Date.now(), folded: this.folded, foldedGroups: this.foldedGroups,
        ...(this.agentAttention.shows(this.agent) ? { agentAttention: () => this.agentAttention.render(t, this.agent) } : {})
      }, act))
      .child(detailView(t, card, act, this.shownDetail(t, card, act)))
  }

  shownDetail(t: Palette, card: Card | null, act: AgentsActions): DetailShown {
    const step = card === null ? null : this.stepShown()
    const runId = card?.runId ?? null
    const of = step === null || runId === null ? null : `${runId}/${step.id}`
    return {
      reading: card === null ? null : this.currentSteps(card),
      target: this.target(),
      merge: card === null ? null : this.merge?.task === card.id ? this.merge.outcome : null,
      step,
      thread: threadShown(t, card, act, this),
      back: { review: this.review, sent: card !== null && this.sent?.of === card.key ? this.sent.reading : null, send: (cx) => this.sendBack(cx) },
      changesProblem: this.changesProblem,
      turns: readingOf(this.output.turns, of),
      log: readingOf(this.output.log, of),
      summary: readingOf(this.output.summary, of),
      thinking: this.openThinking,
      calls: this.openCalls,
      checks: this.flippedChecks,
      turnsScroll: this.output.turnsScroll,
      logScroll: this.output.logScroll,
      checksScroll: this.output.checksScroll,
      flipThinking: (turn, cx) => this.flip(this.openThinking, turn, cx),
      flipCall: (call, cx) => this.flip(this.openCalls, call, cx),
      flipCheck: (check, cx) => this.flip(this.flippedChecks, check, cx)
    }
  }
}
