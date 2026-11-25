import { type Color, type Context, type Element, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { type Card, type CardStatus, type Filter, type RunAgent, cardPlace, filterCards, railLabel } from "./agents"
import { type Reading } from "./orc-read"
import type { palette } from "./palette"
import { type FilterMenu, projectMenu, statusMenu } from "./run-menus"
import { openInbox } from "./views"

type Palette = ReturnType<typeof palette>
export type MenuName = "project" | "status"

export interface RunsActions {
  readonly select: (cx: Context, key: string) => void
  readonly toggleFold: (cx: Context) => void
  readonly setFilter: (cx: Context, filter: Filter) => void
  readonly openMenu: (cx: Context, menu: MenuName | null) => void
}

export interface RunsShown {
  readonly cards: Reading<ReadonlyArray<Card>>
  readonly filter: Filter
  readonly menu: MenuName | null
  readonly selectedKey: string | null
  readonly agents: ReadonlyMap<string, RunAgent | null>
  readonly folded: boolean
}

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

const headerHeight = 44
const triggerHeight = 26
const menuWidth = 174
const menuGap = 8
const columnPadding = 12

const trigger = (t: Palette, name: MenuName, menu: FilterMenu<unknown>, open: MenuName | null, act: RunsActions): Element =>
  h_flex().id(`filter-${name}`).w(menuWidth).h(triggerHeight).px(8).gap(6).items_center().justify_between().rounded(4).cursor_pointer()
    .bg(open === name ? t.selected : t.surface)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => act.openMenu(cx, open === name ? null : name))
    .child(div().min_w_0().truncate().child(`${menu.title}: ${menu.chosen.name}`))
    .child(div().flex_shrink_0().text_color(t.dim).child(String(menu.chosen.count)))
    .child(div().flex_shrink_0().text_color(t.dim).child("▾"))

const menuList = <A>(t: Palette, name: MenuName, menu: FilterMenu<A>, left: number, act: RunsActions, pick: (cx: Context, value: A | null) => void): Element =>
  v_flex().id(`filter-${name}-menu`).absolute().top(headerHeight + triggerHeight + 4).left(left).w(menuWidth).max_h(320).overflow_y_scrollbar()
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_mouse_down_out((_event, cx) => act.openMenu(cx, null))
    .p(4).gap(2).rounded(6).border_1().border_color(t.border).bg(t.raised).shadow_md()
    .children(menu.choices.map((choice) => {
      const chosen = choice === menu.chosen
      const count = div().flex_shrink_0().text_color(t.dim).child(choice.count.toString())
      const shownCount = name === "status" && choice.value === "Awaiting you"
        ? count.id("inbox-count").px(4).rounded(4).hover((style) => style.bg(t.hover).text_color(t.foreground)).on_click((_event, cx) => { act.openMenu(cx, null); openInbox(cx) })
        : count
      return h_flex().id(`filter-${name}-${choice.name}`).px(8).py(3).gap(8).rounded(4).justify_between().cursor_pointer()
        .bg(chosen ? t.selected : t.raised).text_color(chosen ? t.foreground : t.muted)
        .hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => pick(cx, choice.value))
        .child(div().min_w_0().truncate().child(choice.name))
        .child(shownCount)
    }))

const filters = (t: Palette, all: ReadonlyArray<Card>, shown: RunsShown, act: RunsActions): Element =>
  h_flex().gap(menuGap).px(columnPadding).pb(8).items_center().border_b(1).border_color(t.border)
    .child(trigger(t, "project", projectMenu(all, shown.filter), shown.menu, act))
    .child(trigger(t, "status", statusMenu(all, shown.filter), shown.menu, act))

const openList = (t: Palette, all: ReadonlyArray<Card>, shown: RunsShown, act: RunsActions): ReadonlyArray<Element> => {
  const filter = shown.filter
  switch (shown.menu) {
    case "project":
      return [menuList(t, "project", projectMenu(all, filter), columnPadding, act, (cx, project) => { if (project !== null) act.setFilter(cx, { ...filter, ...project }) })]
    case "status":
      return [menuList(t, "status", statusMenu(all, filter), columnPadding + menuWidth + menuGap, act, (cx, status) => act.setFilter(cx, { ...filter, status }))]
    case null:
      return []
  }
}

const cardView = (t: Palette, card: Card, selected: boolean, agent: RunAgent | null, act: RunsActions): Element => {
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

const foldButton = (t: Palette, id: string, label: string, act: RunsActions): Element =>
  div().id(id).px(8).py(2).rounded(4).cursor_pointer().text_size(15).text_color(t.muted)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => act.toggleFold(cx))
    .child(label)

const listBody = (t: Palette, shown: RunsShown, visible: ReadonlyArray<Card>, act: RunsActions): Element => {
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

const rail = (t: Palette, shown: RunsShown, visible: ReadonlyArray<Card>, act: RunsActions): Element =>
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

export const runsColumn = (t: Palette, shown: RunsShown, act: RunsActions): Element => {
  const all = shown.cards.kind === "ok" ? shown.cards.value : []
  const visible = filterCards(all, shown.filter)
  if (shown.folded) {
    return rail(t, shown, visible, act)
  }
  return v_flex().relative().w(380).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
    .child(h_flex().px(columnPadding).h(headerHeight).items_center().justify_between()
      .child(div().text_size(15).font_semibold().child("Runs"))
      .child(foldButton(t, "fold", "«", act)))
    .child(filters(t, all, shown, act))
    .child(listBody(t, shown, visible, act))
    .children(openList(t, all, shown, act))
}
