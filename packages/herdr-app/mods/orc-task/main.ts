import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { Input, InputState, TextView, h_flex, v_flex } from "gpui-base"
import { openOverlay, run, setShared, shared } from "herdr"
import { type Sent, actionButton, failureLine, listenFor, sendOrc } from "../../src/ask-view"
import { type QueuedRun, kindLabel, queueLine } from "../../src/board"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type AnswerTarget, type TaskDetail, type TaskRun, answerArgv, descriptionOf, infoRows, mergeArgv, mergeablePr, runToOpen, runsOfTask } from "../../src/task"
import { taskDetails, taskRuns, taskRunsAndQueue, thread } from "../../src/task-guard"
import { type Thread, type ThreadCard, threadCards } from "../../src/thread"
import { type ThreadControls, threadDecided, threadEntry } from "../../src/thread-view"
import { linkedText } from "../../src/links-view"
import { holdsOnTasks } from "../../src/inbox"
import { agentsOpenKey, selectedTaskKey, viewsStack, refreshWhenShown, reloadNow } from "../../src/views"

type Palette = ReturnType<typeof palette>
type Tab = "Thread" | "Description" | "Info"
const tabs: ReadonlyArray<Tab> = ["Thread", "Description", "Info"]

interface TaskDocuments {
  readonly tasks: ReadonlyArray<TaskDetail>
  readonly runs: ReadonlyArray<TaskRun>
  readonly queued: ReadonlyArray<QueuedRun>
  readonly local: ReadonlyArray<TaskRun>
  readonly thread: Reading<Thread> | null
}

const selectedTask = (): string | null => {
  const value = shared(selectedTaskKey)
  return typeof value === "string" ? value : null
}

export default class OrcTask extends View {
  reading: Reading<TaskDocuments> = { kind: "reading" }
  visible = false
  lastRead = 0
  busy = false
  stale = false
  selectSeq = 0
  tab: Tab = "Thread"
  shownTask: string | null = null
  boxes = new Map<string, InputState>()
  sent = new Map<string, Sent>()
  merging: string | null = null

  load = (): Promise<Reading<TaskDocuments>> => {
    const id = selectedTask()
    return Promise.all([
      readJson("orc", ["backlog", "--json"], taskDetails),
      readJson("orc", ["runs", "--json"], taskRunsAndQueue),
      readJson("orc", ["runs", "--json", "--local"], taskRuns),
      id === null ? Promise.resolve(null) : readJson("orc", ["backlog", "thread", id, "--json"], thread)
    ]).then(([tasks, runs, local, told]) =>
      tasks.kind !== "ok" ? tasks : runs.kind !== "ok" ? runs : local.kind !== "ok" ? local : { kind: "ok", value: { tasks: tasks.value, runs: runs.value.runs, queued: runs.value.queued, local: local.value, thread: told } })
  }

  override init(_props: unknown, cx: AsyncContext): void {
    refreshWhenShown("orc-board", 10_000, cx, this)
    cx.timer.every(150, (tick) => this.syncBoxes(tick))
    cx.spawn((task) => listenFor("merge", () => this.merge(task)))
  }

  reload(cx: Context): void {
    reloadNow(cx, this)
  }

  orc(cx: Context, key: string, argv: ReadonlyArray<string>, done: () => void): void {
    const issued = this.selectSeq
    sendOrc(this, cx, key, argv, done, () => issued === this.selectSeq)
  }

  answer(cx: Context, task: string, key: string, reply: AnswerTarget, words: string, done: () => void): void {
    if (this.sent.get(key)?.kind === "sending") return
    const argv = answerArgv(task, reply, words)
    if (argv === null) return
    this.orc(cx, key, argv, done)
  }

  answerFromBox(cx: Context, task: string, card: ThreadCard, reply: AnswerTarget): void {
    const box = this.boxes.get(card.key)
    if (box !== undefined) this.answer(cx, task, card.key, reply, box.value(), () => box.set_value(""))
  }

  cards(task: TaskDetail): ReadonlyArray<ThreadCard> | null {
    if (this.reading.kind !== "ok") return null
    const told = this.reading.value.thread
    return told?.kind === "ok" && told.value.task === task.id ? threadCards(told.value, task, holdsOnTasks(this.reading.value.tasks).get(task.id)) : null
  }

  askMerge(task: string): void {
    this.merging = task
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      width: 420,
      height: 180,
      props: { title: `Merge the PR of ${task}?`, detail: `orc ${mergeArgv(task).join(" ")}`, command: { name: "orc-task.merge" } }
    })
  }

  merge(cx: Context): void {
    const task = this.merging
    this.merging = null
    if (task === null || task !== selectedTask()) return
    this.orc(cx, "merge", mergeArgv(task), () => undefined)
  }

  // InputState.new refuses to run during render, so boxes are made here on a timer tick.
  syncBoxes(cx: AsyncContext): void {
    const id = selectedTask()
    let changed = false
    if (id !== this.shownTask) {
      this.selectSeq += 1
      this.shownTask = id
      this.tab = "Thread"
      for (const box of this.boxes.values()) box.release()
      this.boxes.clear()
      this.sent.clear()
      if (id !== null) reloadNow(cx, this)
      changed = true
    }
    const task = this.reading.kind === "ok" ? this.reading.value.tasks.find((entry) => entry.id === id) : undefined
    if (task !== undefined && this.makeBoxes(task)) changed = true
    if (changed) cx.notify()
  }

  makeBoxes(task: TaskDetail): boolean {
    let made = false
    for (const card of this.cards(task) ?? []) {
      const reply = card.reply
      if (reply === null || this.boxes.has(card.key)) continue
      const box = InputState.new({ placeholder: reply.kind === "hold" ? "Answer the hold" : `Answer ${reply.id}` })
      box.on("submit", (_event, submitCx) => this.answerFromBox(submitCx, task.id, card, reply))
      this.boxes.set(card.key, box)
      made = true
    }
    return made
  }

  render(): Element {
    const t = palette()
    const id = this.shownTask
    const root = v_flex().id("root").size_full().min_w_0().bg(t.background).border_l(1).border_color(t.border).text_size(13).text_color(t.foreground)
    if (id === null) return root.child(div().p(16).text_color(t.muted).child("Select a card to see its task"))
    if (this.reading.kind === "failed") return root.child(div().p(16).text_color(t.blocked).child(this.reading.reason))
    if (this.reading.kind === "reading") return root.child(div().p(16).text_color(t.muted).child("Reading the task"))
    const task = this.reading.value.tasks.find((entry) => entry.id === id)
    if (task === undefined) return root.child(div().p(16).text_color(t.muted).child(`${id} is no longer in the backlog`))
    const runs = runsOfTask(this.reading.value.runs, task.id)
    const local = new Set(this.reading.value.local.map((localRun) => localRun.id))
    return root.child(this.header(t, task, runToOpen(runs, local), queueLine(this.reading.value.queued, task.id)))
      .child(this.tabStrip(t))
      .child(this.tabBody(t, task, runs))
  }

  header(t: Palette, task: TaskDetail, open: string | null, waiting: string | null): Element {
    const facts = v_flex().flex_1().min_w_0().gap(4)
      .child(h_flex().gap(8).child(div().font_semibold().child(task.id)).child(div().text_color(t.dim).child(kindLabel(task.kind))))
      .child(div().text_size(15).font_semibold().child(task.title))
    const actions = open !== null ? [actionButton(t, "open-run", "Open run", false, () => {
      setShared(agentsOpenKey, { run: open, at: Date.now() })
      run("layout.select", { stack: viewsStack, child: "orc-agents" })
    })] : waiting !== null ? [div().flex_shrink_0().py(4).text_color(t.muted).child(waiting)] : []
    const close = div().id("close").flex_shrink_0().px(6).rounded(4).cursor_pointer().text_color(t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click(() => setShared(selectedTaskKey, null))
      .child("✕")
    return h_flex().px(16).py(12).gap(12).items_start().border_b(1).border_color(t.border).child(facts).children(actions).child(close)
  }

  tabStrip(t: Palette): Element {
    return h_flex().px(12).h(36).gap(4).items_center().border_b(1).border_color(t.border)
      .children(tabs.map((tab) => {
        const shown = tab === this.tab
        return div().id(`tab-${tab}`).px(10).py(3).rounded(4).cursor_pointer()
          .bg(shown ? t.selected : t.background).text_color(shown ? t.foreground : t.muted)
          .hover((style) => style.bg(t.hover))
          .on_click((_event, cx) => { this.tab = tab; cx.notify() })
          .child(tab)
      }))
  }

  tabBody(t: Palette, task: TaskDetail, runs: ReadonlyArray<TaskRun>): Element {
    const body = v_flex().id(`body-${this.tab}`).flex_1().min_h_0().overflow_y_scrollbar().p(16).gap(12)
    switch (this.tab) {
      case "Thread": {
        const told = this.reading.kind === "ok" ? this.reading.value.thread : null
        if (told?.kind === "failed") return body.child(div().text_color(t.blocked).child(told.reason))
        const cards = this.cards(task)
        if (cards === null || told?.kind !== "ok") return body.child(div().text_color(t.muted).child("Reading the thread"))
        return cards.length === 0
          ? body.child(div().text_color(t.muted).child(`Nothing is said on ${task.id} yet`))
          : body.children(cards.map((card) => threadEntry(t, card, this.controls(task.id)))).children(threadDecided(t, told.value))
      }
      case "Description": {
        const description = descriptionOf(task.body)
        return description === ""
          ? body.child(div().text_color(t.muted).child("No description"))
          : body.child(TextView.markdown(`description-${task.id}`, description))
      }
      case "Info":
        return body.gap(6).children(infoRows(task, runs).map((row) => {
          const line = h_flex().gap(12).items_start()
            .child(div().w(96).flex_shrink_0().text_color(t.dim).child(row.label))
            .child(div().flex_1().min_w_0().child(linkedText(`info-${row.label}`, row.value)))
          return row.label === "PR" && mergeablePr(task) !== null ? line.child(this.mergeButton(t, task.id)) : line
        })).children(failureLine(t, this.sent.get("merge")))
    }
  }

  mergeButton(t: Palette, task: string): Element {
    return actionButton(t, "merge", "Merge", this.sent.get("merge")?.kind === "sending", () => this.askMerge(task))
  }

  controls(task: string): ThreadControls {
    return {
      option: (card, option, shown) => {
        const reply = card.reply
        if (reply === null || reply.kind !== "question" || this.sent.get(card.key)?.kind === "sending") return shown
        return shown.cursor_pointer().hover((style) => style.bg(palette().hover))
          .on_click((_event, cx) => this.answer(cx, task, card.key, reply, option.text, () => undefined))
      },
      reply: (card) => this.replyBox(palette(), task, card),
      failure: (card) => failureLine(palette(), this.sent.get(card.key))
    }
  }

  replyBox(t: Palette, task: string, card: ThreadCard): ReadonlyArray<Element> {
    const reply = card.reply
    const box = this.boxes.get(card.key)
    if (reply === null || box === undefined) return []
    const sending = this.sent.get(card.key)?.kind === "sending"
    return [h_flex().gap(8).items_center()
      .child(Input.new(box).flex_1().h(32).px(8).rounded(6).border(1).border_color(t.border).bg(t.background))
      .child(actionButton(t, `send-${card.key}`, sending ? "Sending" : "Send", sending, (cx) => this.answerFromBox(cx, task, card, reply)))]
  }
}
