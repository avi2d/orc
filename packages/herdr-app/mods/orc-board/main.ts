import { type AsyncContext, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { ScrollHandle, h_flex, v_flex } from "gpui-base"
import { setShared, shared } from "herdr"
import { refreshWhenShown, selectedTaskKey } from "../../src/views"
import { type BoardTask, type Lane, type LaneView, cardBox, kindLabel, laneJump, lanes, tasksInLane, titleClip, wheelOffset } from "../../src/board"
import { type BoardAttention, type BoardBacklog, boardAttention, boardBacklog } from "../../src/guard-board"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"

type Palette = ReturnType<typeof palette>
interface BoardDocuments {
  readonly backlog: BoardBacklog
  readonly attention: BoardAttention
}

const perLane = <T>(make: () => T): Record<Lane, T> =>
  ({ Backlog: make(), Planned: make(), "Awaiting you": make(), Running: make(), Done: make() })

export default class OrcBoard extends View {
  reading: Reading<BoardDocuments> = { kind: "reading" }
  project: string | null = null
  folded = new Set<Lane>(["Backlog", "Done"])
  visible = false
  lastRead = 0
  busy = false
  scrolls = perLane(() => ScrollHandle.new())
  focus: Record<Lane, FocusHandle> | null = null
  views = new Map<Lane, LaneView>()

  load = (): Promise<Reading<BoardDocuments>> => Promise.all([
    readJson("orc", ["backlog", "--json"], boardBacklog),
    readJson("orc", ["attention", "--json"], boardAttention)
  ]).then(([backlog, attention]) =>
    backlog.kind !== "ok" ? backlog : attention.kind !== "ok" ? attention : { kind: "ok", value: { backlog: backlog.value, attention: attention.value } })

  override init(_props: unknown, cx: AsyncContext): void {
    this.focus = perLane(() => cx.focus_handle())
    refreshWhenShown("orc-board", 10_000, cx, this)
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
      .child(h_flex().id("lanes").flex_1().min_h_0().min_w_0().overflow_x_scroll()
        .children(lanes.map((lane) => this.lane(t, lane, tasksInLane(backlog.tasks, lane, this.project, owned)))))
  }

  lane(t: Palette, lane: Lane, tasks: ReadonlyArray<BoardTask>): Element {
    const folded = this.folded.has(lane)
    const header = h_flex().id(`toggle-${lane}`).h(44).flex_shrink_0().px(8).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(t.hover)).on_click((_event, cx) => this.toggle(cx, lane))
      .child(div().flex_1().child(lane)).child(div().text_color(t.muted).child(String(tasks.length)))
      .child(div().text_color(t.muted).child(folded ? "»" : "«"))
    const column = v_flex().id(`lane-${lane}`).h_full().min_h_0().flex_shrink_0().w(folded ? 110 : 260)
      .bg(t.chrome).border_r(1).border_color(t.border).child(header)
    if (folded) return column
    const view = (): LaneView => this.views.get(lane) ?? { offsetPx: 0, heightPx: 0 }
    const focus = this.focus?.[lane]
    const keyed = focus === undefined ? column : column.track_focus(focus)
      .on_mouse_down("left", () => focus.focus())
      .on_key_down((event, cx) => {
        const jump = laneJump(event.key, view(), tasks.length)
        if (jump === null) return
        this.scrolls[lane].scroll_to_item(jump.item)
        this.views.set(lane, { ...view(), offsetPx: jump.offsetPx })
        cx.stop_propagation()
      })
    return keyed.child(v_flex().id(`cards-${lane}`).flex_1().min_h_0().overflow_y_scrollbar().track_scroll(this.scrolls[lane])
      .p(cardBox.padPx).gap(cardBox.gapPx)
      .on_size_change((size) => this.views.set(lane, { ...view(), heightPx: size.height }))
      .on_scroll_wheel((event) => this.views.set(lane, { ...view(), offsetPx: wheelOffset(view(), tasks.length, event.delta.y) }))
      .children(tasks.map((task) => this.card(t, task))))
  }

  card(t: Palette, task: BoardTask): Element {
    const selected = shared(selectedTaskKey) === task.id
    return v_flex().id(`card-${task.id}`).h(cardBox.heightPx).p(8).gap(4).rounded(6).cursor_pointer().flex_shrink_0()
      .bg(selected ? t.selected : t.background)
      .hover((style) => style.bg(selected ? t.selected : t.hover))
      .on_click(() => setShared(selectedTaskKey, task.id))
      .child(h_flex().gap(8).child(div().font_semibold().child(task.id)).child(div().text_color(t.dim).child(kindLabel(task.kind))))
      .child(div().h(titleClip.heightPx).line_height(`${titleClip.lineHeightPx}px`).overflow_hidden().child(task.title))
  }
}
