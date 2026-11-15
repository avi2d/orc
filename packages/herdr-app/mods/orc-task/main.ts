import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { Input, InputState, TextView, h_flex, v_flex } from "gpui-base"
import { exec, nextCommand, openOverlay, run, setShared, shared } from "herdr"
import { kindLabel } from "../../src/board"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type AnswerTarget, type TaskDetail, type TaskRun, type ThreadEntry, answerArgv, descriptionOf, infoRows, mergeArgv, runToOpen, runsOfTask, shortTime, threadEntries } from "../../src/task"
import { taskDetails, taskRuns } from "../../src/task-guard"
import { agentsOpenKey, selectedTaskKey, viewsStack, refreshWhenShown } from "../../src/views"

type Palette = ReturnType<typeof palette>
type Tab = "Thread" | "Description" | "Info"
const tabs: ReadonlyArray<Tab> = ["Thread", "Description", "Info"]

interface TaskDocuments {
  readonly tasks: ReadonlyArray<TaskDetail>
  readonly runs: ReadonlyArray<TaskRun>
  readonly local: ReadonlyArray<TaskRun>
}

type Sent = { readonly kind: "sending" } | { readonly kind: "failed"; readonly reason: string }

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

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

  load = (): Promise<Reading<TaskDocuments>> => Promise.all([
    readJson("orc", ["backlog", "--json"], taskDetails),
    readJson("orc", ["runs", "--json"], taskRuns),
    readJson("orc", ["runs", "--json", "--local"], taskRuns)
  ]).then(([tasks, runs, local]) =>
    tasks.kind !== "ok" ? tasks : runs.kind !== "ok" ? runs : local.kind !== "ok" ? local : { kind: "ok", value: { tasks: tasks.value, runs: runs.value, local: local.value } })

  override init(_props: unknown, cx: AsyncContext): void {
    refreshWhenShown("orc-board", 10_000, cx, this)
    cx.timer.every(150, (tick) => this.syncBoxes(tick))
    cx.spawn((task) => this.listen(task))
  }

  listen(cx: AsyncContext): Promise<void> {
    return nextCommand().then((command) => {
      if (command === "merge") this.merge(cx)
      return this.listen(cx)
    })
  }

  reload(cx: Context): void {
    if (this.busy) {
      this.stale = true
      return
    }
    this.busy = true
    cx.spawn((task) => this.load().then((reading) => {
      this.reading = reading
      this.busy = false
      if (this.stale) {
        this.stale = false
        this.reload(task)
      }
      task.notify()
    }))
  }

  orc(cx: Context, key: string, argv: ReadonlyArray<string>, done: () => void): void {
    const issued = this.selectSeq
    this.sent.set(key, { kind: "sending" })
    cx.spawn((task) => exec("orc", [...argv]).then(
      (result) => {
        if (issued !== this.selectSeq) {
          this.reload(task)
          task.notify()
          return
        }
        if (result.code === 0) {
          this.sent.delete(key)
          done()
        } else {
          this.sent.set(key, { kind: "failed", reason: `orc ${argv.join(" ")} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}` })
        }
        this.reload(task)
        task.notify()
      },
      () => {
        if (issued !== this.selectSeq) return
        this.sent.set(key, { kind: "failed", reason: "Could not start orc. Check that it is on PATH." })
        task.notify()
      }
    ))
    cx.notify()
  }

  answer(cx: Context, task: string, entry: ThreadEntry, reply: AnswerTarget): void {
    if (this.sent.get(entry.key)?.kind === "sending") return
    const box = this.boxes.get(entry.key)
    if (box === undefined) return
    const argv = answerArgv(task, reply, box.value())
    if (argv === null) return
    this.orc(cx, entry.key, argv, () => box.set_value(""))
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
      changed = true
    }
    const task = this.reading.kind === "ok" ? this.reading.value.tasks.find((entry) => entry.id === id) : undefined
    if (task !== undefined && this.makeBoxes(task)) changed = true
    if (changed) cx.notify()
  }

  makeBoxes(task: TaskDetail): boolean {
    let made = false
    for (const entry of threadEntries(task)) {
      const reply = entry.reply
      if (reply === null || this.boxes.has(entry.key)) continue
      const box = InputState.new({ placeholder: reply.kind === "hold" ? "Answer the hold" : `Answer ${reply.id}` })
      box.on("submit", (_event, submitCx) => this.answer(submitCx, task.id, entry, reply))
      this.boxes.set(entry.key, box)
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
    return root.child(this.header(t, task, runToOpen(runs, local)))
      .child(this.tabStrip(t))
      .child(this.tabBody(t, task, runs))
  }

  header(t: Palette, task: TaskDetail, open: string | null): Element {
    const facts = v_flex().flex_1().min_w_0().gap(4)
      .child(h_flex().gap(8).child(div().font_semibold().child(task.id)).child(div().text_color(t.dim).child(kindLabel(task.kind))))
      .child(div().text_size(15).font_semibold().child(task.title))
    const actions = open === null ? [] : [this.button(t, "open-run", "Open run", false, () => {
      setShared(agentsOpenKey, { run: open, at: Date.now() })
      run("layout.select", { stack: viewsStack, child: "orc-agents" })
    })]
    const close = div().id("close").flex_shrink_0().px(6).rounded(4).cursor_pointer().text_color(t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click(() => setShared(selectedTaskKey, null))
      .child("✕")
    return h_flex().px(16).py(12).gap(12).items_start().border_b(1).border_color(t.border).child(facts).children(actions).child(close)
  }

  button(t: Palette, id: string, label: string, busy: boolean, press: (cx: Context) => void): Element {
    const button = div().id(id).flex_shrink_0().px(12).py(4).rounded(6).border(1).border_color(t.border).bg(t.raised)
    return busy
      ? button.text_color(t.dim).child(label)
      : button.cursor_pointer().hover((style) => style.bg(t.hover)).on_click((_event, cx) => press(cx)).child(label)
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
        const entries = threadEntries(task)
        return entries.length === 0
          ? body.child(div().text_color(t.muted).child("No hold and no questions"))
          : body.children(entries.map((entry) => this.entry(t, task.id, entry)))
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
            .child(div().flex_1().min_w_0().child(row.value))
          return row.label === "PR" && task.prState === "open" ? line.child(this.mergeButton(t, task.id)) : line
        })).children(this.failure(t, "merge"))
    }
  }

  mergeButton(t: Palette, task: string): Element {
    return this.button(t, "merge", "Merge", this.sent.get("merge")?.kind === "sending", () => this.askMerge(task))
  }

  failure(t: Palette, key: string): ReadonlyArray<Element> {
    const sent = this.sent.get(key)
    return sent?.kind === "failed" ? [div().text_color(t.blocked).child(sent.reason)] : []
  }

  entry(t: Palette, task: string, entry: ThreadEntry): Element {
    const line = h_flex().gap(6).text_size(12)
      .child(div().font_semibold().child(entry.who))
      .child(div().text_color(t.dim).child("·"))
      .child(div().text_color(t.muted).child(entry.what))
      .children(entry.at === null ? [] : [div().text_color(t.dim).child("·"), div().text_color(t.dim).child(shortTime(entry.at))])
    const card = v_flex().id(`entry-${entry.key}`).gap(6).p(10).rounded(6).bg(entry.who === "Answer" ? t.surface : t.raised)
      .child(line).child(div().child(entry.text))
    const reply = entry.reply
    if (reply === null) return card
    const box = this.boxes.get(entry.key)
    if (box === undefined) return card
    const sending = this.sent.get(entry.key)?.kind === "sending"
    return card.child(h_flex().gap(8).items_center()
      .child(Input.new(box).flex_1().h(32).px(8).rounded(6).border(1).border_color(t.border).bg(t.background))
      .child(this.button(t, `send-${entry.key}`, sending ? "Sending" : "Send", sending, (cx) => this.answer(cx, task, entry, reply))))
      .children(this.failure(t, entry.key))
  }
}
