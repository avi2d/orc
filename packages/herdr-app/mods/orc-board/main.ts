import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { layout } from "herdr"
import { type BoardTask, cardTitle, type Lane, lanes, tasksInLane, titleLines } from "../../src/board"
import { type BoardAttention, type BoardBacklog, boardAttention, boardBacklog } from "../../src/guard"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { activeChild, viewsStack } from "../../src/views"

type Palette = ReturnType<typeof palette>
interface BoardDocuments {
  readonly backlog: BoardBacklog
  readonly attention: BoardAttention
}

const shown = (): boolean => {
  const active = activeChild(layout(), viewsStack)
  return active === null || active === "orc-board"
}

const kindLabel = (kind: BoardTask["kind"]): string => {
  switch (kind) {
    case "ship": return "Code"
    case "scout": return "Research"
    case "task": return "Ops"
    case "decision": return "Decision"
    case "parent": return "Parent"
  }
}

export default class OrcBoard extends View {
  reading: Reading<BoardDocuments> = { kind: "reading" }
  project: string | null = null
  selected: string | null = null
  folded = new Set<Lane>(["Backlog", "Done"])
  visible = false
  lastRead = 0
  busy = false

  override init(_props: unknown, cx: AsyncContext): void {
    cx.timer.every(1000, (tick) => {
      const nowShown = shown()
      if (nowShown && (!this.visible || Date.now() - this.lastRead >= 10_000)) this.refresh(tick)
      this.visible = nowShown
    })
    if (shown()) {
      this.visible = true
      this.refresh(cx)
    }
  }

  refresh(cx: Context): void {
    if (this.busy) return
    this.busy = true
    this.lastRead = Date.now()
    cx.spawn((task) => Promise.all([
      readJson("orc", ["backlog", "--json"], boardBacklog),
      readJson("orc", ["attention", "--json"], boardAttention)
    ]).then(([backlog, attention]) => {
      this.reading = backlog.kind !== "ok" ? backlog : attention.kind !== "ok" ? attention : { kind: "ok", value: { backlog: backlog.value, attention: attention.value } }
      this.busy = false
      task.notify()
    }))
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
    const t = palette()
    const root = v_flex().id("root").size_full().bg(t.surface).text_size(13).text_color(t.foreground)
    if (this.reading.kind === "failed") return root.child(div().p(16).text_color(t.blocked).child(this.reading.reason))
    if (this.reading.kind === "reading") return root.child(div().p(16).text_color(t.muted).child("Reading the backlog"))
    const { backlog, attention } = this.reading.value
    const owned = new Set(attention.items.filter((item) => item.owner === "user").map((item) => item.task))
    const filters = h_flex().id("filters").gap(4).px(12).py(8).flex_wrap().items_center()
      .child(div().text_color(t.dim).child("Project"))
      .child(this.chip(t, "project-all", "All", this.project === null, (cx) => { this.project = null; cx.notify() }))
      .children((backlog.projects ?? []).map((project) => this.chip(t, `project-${project}`, project, this.project === project, (cx) => { this.project = project; cx.notify() })))
    return root.child(filters)
      .children(backlog.projects === null ? [div().px(12).text_color(t.blocked).child("Projects could not be read")] : [])
      .child(h_flex().id("lanes").flex_1().min_w_0().overflow_x_scroll()
        .children(lanes.map((lane) => this.lane(t, lane, tasksInLane(backlog.tasks, lane, this.project, owned)))))
  }

  lane(t: Palette, lane: Lane, tasks: ReadonlyArray<BoardTask>): Element {
    const folded = this.folded.has(lane)
    const header = h_flex().id(`toggle-${lane}`).h(44).px(8).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(t.hover)).on_click((_event, cx) => this.toggle(cx, lane))
      .child(div().flex_1().child(lane)).child(div().text_color(t.muted).child(String(tasks.length)))
      .child(div().text_color(t.muted).child(folded ? "»" : "«"))
    const column = v_flex().id(`lane-${lane}`).h_full().flex_shrink_0().w(folded ? 110 : 260)
      .bg(t.chrome).border_r(1).border_color(t.border).child(header)
    return folded ? column : column.child(v_flex().id(`cards-${lane}`).flex_1().overflow_y_scrollbar().p(8).gap(6)
      .children(tasks.map((task) => this.card(t, task))))
  }

  card(t: Palette, task: BoardTask): Element {
    const selected = this.selected === task.id
    return v_flex().id(`card-${task.id}`).h(84).p(8).gap(4).rounded(6).cursor_pointer().flex_shrink_0()
      .bg(selected ? t.selected : t.background)
      .hover((style) => style.bg(selected ? t.selected : t.hover))
      .on_click((_event, cx) => { this.selected = task.id; cx.notify() })
      .child(h_flex().gap(8).child(div().font_semibold().child(task.id)).child(div().text_color(t.dim).child(kindLabel(task.kind))))
      .child(div().h(titleLines * 18).line_height("18px").overflow_hidden().children(cardTitle(task.title).map((line) => div().child(line))))
  }
}
