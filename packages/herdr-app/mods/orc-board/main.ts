import { type AsyncContext, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { run, setShared, shared } from "herdr"
import { refreshWhenShown, selectedTaskKey } from "../../src/views"
import { type BoardTask, type Lane, type QueuedRun, clickedSelection, kindLabel, lanes, panelCommand, queueLine, selectionOnBoard, tasksInLane, titleClip } from "../../src/board"
import { type BoardAttention, type BoardBacklog, boardAttention, boardBacklog, boardQueue } from "../../src/guard-board"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"

type Palette = ReturnType<typeof palette>
const taskBlock = "orc-task"
interface BoardDocuments {
  readonly backlog: BoardBacklog
  readonly attention: BoardAttention
}

export default class OrcBoard extends View {
  reading: Reading<BoardDocuments> = { kind: "reading" }
  queue: Reading<ReadonlyArray<QueuedRun>> = { kind: "reading" }
  project: string | null = null
  folded = new Set<Lane>(["Backlog", "Done"])
  visible = false
  lastRead = 0
  busy = false
  lastQueueRead = 0
  queueBusy = false
  panelShown: boolean | null = null
  focusHandle: FocusHandle | null = null

  load = (): Promise<Reading<BoardDocuments>> => Promise.all([
    readJson("orc", ["backlog", "--json"], boardBacklog),
    readJson("orc", ["attention", "--json"], boardAttention)
  ]).then(([backlog, attention]) =>
    backlog.kind !== "ok" ? backlog : attention.kind !== "ok" ? attention : { kind: "ok", value: { backlog: backlog.value, attention: attention.value } })

  loadQueue = (): Promise<Reading<ReadonlyArray<QueuedRun>>> => readJson("orc", ["runs", "--json"], boardQueue)

  reloadQueue(cx: Context): void {
    if (this.queueBusy) return
    this.queueBusy = true
    this.lastQueueRead = Date.now()
    cx.spawn((task) => this.loadQueue().then((queue) => {
      this.queue = queue
      this.queueBusy = false
      task.notify()
    }))
  }

  override init(_props: unknown, cx: AsyncContext): void {
    this.focusHandle = cx.focus_handle()
    refreshWhenShown("orc-board", 10_000, cx, this)
    cx.timer.every(1000, (tick) => {
      if (!this.visible || Date.now() - this.lastQueueRead < 10_000) return
      this.reloadQueue(tick)
    })
    if (this.visible) this.reloadQueue(cx)
  }

  selected(): string | null {
    const value = shared(selectedTaskKey)
    return typeof value === "string" ? value : null
  }

  // setShared redraws every mod and layout.show moves the columns, so both go out only when the value changed.
  syncPanel(): void {
    const selected = this.selected()
    const kept = selectionOnBoard(selected, this.reading.kind === "ok" ? this.reading.value.backlog.tasks : null)
    if (kept !== selected) setShared(selectedTaskKey, kept)
    const command = panelCommand(kept, this.panelShown)
    if (command !== null) {
      this.panelShown = kept !== null
      run(command, { id: taskBlock })
    }
  }

  closeOnEscape(element: Element): Element {
    if (this.focusHandle === null) return element
    return element.track_focus(this.focusHandle).on_key_down((event, cx) => {
      if (event.key !== "escape" || this.selected() === null) return
      setShared(selectedTaskKey, null)
      cx.stop_propagation()
    })
  }

  toggle(cx: Context, lane: Lane): void {
    if (this.folded.has(lane)) this.folded.delete(lane)
    else this.folded.add(lane)
    cx.notify()
  }

  chip(t: Palette, id: string, label: string, selected: boolean, action: (cx: Context) => void): Element {
    return div().id(id).px(8).py(3).rounded(4).cursor_pointer()
      .bg(selected ? t.selected : t.surface).text_color(selected ? t.foreground : t.muted)
      .hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => action(cx)).child(label)
  }

  render(): Element {
    this.syncPanel()
    const t = palette()
    const root = this.closeOnEscape(v_flex().id("root").size_full().bg(t.surface).text_size(13).text_color(t.foreground))
    if (this.reading.kind === "failed") return root.child(div().p(16).text_color(t.blocked).child(this.reading.reason))
    if (this.reading.kind === "reading") return root.child(div().p(16).text_color(t.muted).child("Reading the backlog"))
    const { backlog, attention } = this.reading.value
    const queued = this.queue.kind === "ok" ? this.queue.value : []
    const owned = new Set(attention.items.filter((item) => item.owner === "user").map((item) => item.task))
    const filters = h_flex().id("filters").gap(4).px(12).py(8).flex_wrap().items_center()
      .child(div().text_color(t.dim).child("Project"))
      .child(this.chip(t, "project-all", "All", this.project === null, (cx) => { this.project = null; cx.notify() }))
      .children((backlog.projects ?? []).map((project) => this.chip(t, `project-${project}`, project, this.project === project, (cx) => { this.project = project; cx.notify() })))
    return root.child(filters)
      .children(backlog.projects === null ? [div().px(12).text_color(t.blocked).child("Projects could not be read")] : [])
      .children(this.queue.kind === "failed" ? [div().px(12).text_color(t.blocked).child("Queue could not be read")] : [])
      .child(h_flex().id("lanes").flex_1().min_w_0().overflow_x_scroll()
        .children(lanes.map((lane) => this.lane(t, lane, tasksInLane(backlog.tasks, lane, this.project, owned), queued))))
  }

  lane(t: Palette, lane: Lane, tasks: ReadonlyArray<BoardTask>, queued: ReadonlyArray<QueuedRun>): Element {
    const folded = this.folded.has(lane)
    const header = h_flex().id(`toggle-${lane}`).h(44).px(8).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(t.hover)).on_click((_event, cx) => this.toggle(cx, lane))
      .child(div().flex_1().child(lane)).child(div().text_color(t.muted).child(String(tasks.length)))
      .child(div().text_color(t.muted).child(folded ? "»" : "«"))
    const column = v_flex().id(`lane-${lane}`).h_full().flex_shrink_0().w(folded ? 110 : 260)
      .bg(t.chrome).border_r(1).border_color(t.border).child(header)
    return folded ? column : column.child(v_flex().id(`cards-${lane}`).flex_1().overflow_y_scrollbar().p(8).gap(6)
      .children(tasks.map((task) => this.card(t, task, queueLine(queued, task.id)))))
  }

  card(t: Palette, task: BoardTask, waiting: string | null): Element {
    const selected = this.selected() === task.id
    return v_flex().id(`card-${task.id}`).h(waiting === null ? 84 : 106).p(8).gap(4).rounded(6).cursor_pointer().flex_shrink_0()
      .bg(selected ? t.selected : t.background)
      .hover((style) => style.bg(selected ? t.selected : t.hover))
      .on_click(() => {
        this.focusHandle?.focus()
        setShared(selectedTaskKey, clickedSelection(this.selected(), task.id))
      })
      .child(h_flex().gap(8).child(div().font_semibold().child(task.id)).child(div().text_color(t.dim).child(kindLabel(task.kind))))
      .child(div().h(titleClip.heightPx).line_height(`${titleClip.lineHeightPx}px`).overflow_hidden().child(task.title))
      .children(waiting === null ? [] : [div().text_color(t.muted).child(waiting)])
  }
}
