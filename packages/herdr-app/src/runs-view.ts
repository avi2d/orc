import { type Context, type Element, div } from "gpui-kit"
import { type InputState, h_flex, v_flex } from "gpui-base"
import { type Card, type CardStatus, type Filter, cardStatuses, filterCards, railLabel, unfoldedCards } from "./agents"
import { type RowFacts, rowFacts } from "./agent-row"
import { type AlertAction, type AlertShown, alert, button, field, selectTrigger, statusDot, vendorLogo, zinc } from "./kit"
import type { palette } from "./palette"
import type { RunFacts } from "./run-agent"
import { projectMenu } from "./run-menus"
import { uniformRows } from "./rows-list"
import { shortTime } from "./task"

type Palette = ReturnType<typeof palette>

export interface RunsActions {
  readonly select: (cx: Context, key: string) => void
  readonly toggleFold: (cx: Context) => void
  readonly toggleGroup: (cx: Context, status: CardStatus) => void
  readonly setFilter: (cx: Context, filter: Filter) => void
  readonly openMenu: (cx: Context, open: boolean) => void
  readonly clearFind: (cx: Context) => void
  readonly retry: (cx: Context) => void
}

export type ListReading =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "ok"; readonly cards: ReadonlyArray<Card>; readonly reread: Reread | null }

export interface Reread {
  readonly reason: string
  readonly listed: string
}

const rereadBody = (reread: Reread): string => `${reread.reason.replace(/\.$/, "")}. The list below is from ${shortTime(reread.listed)}.`

export interface RunsShown {
  readonly list: ListReading
  readonly filter: Filter
  readonly find: InputState
  readonly menuOpen: boolean
  readonly selectedKey: string | null
  readonly facts: ReadonlyMap<string, RunFacts | null>
  readonly now: number
  readonly folded: boolean
  readonly foldedGroups: ReadonlySet<CardStatus>
  readonly agentAttention?: () => ReadonlyArray<Element>
}

type ListRow =
  | { readonly kind: "group"; readonly status: CardStatus; readonly count: number }
  | { readonly kind: "card"; readonly card: Card }

type ShownRow =
  | { readonly kind: "group"; readonly status: CardStatus; readonly count: number }
  | { readonly kind: "card"; readonly card: Card; readonly facts: RowFacts }

interface Note {
  readonly key: string
  readonly shown: AlertShown
}

interface ListBody {
  readonly notes: ReadonlyArray<Note>
  readonly rows: ReadonlyArray<ListRow>
}

const listWidth = 360
const railWidth = 112
const rowHeight = 26
const menuWidth = 200
const headerPadding = 12

const findWords = (shown: RunsShown): string => shown.find.value().trim()

const groupRows = (visible: ReadonlyArray<Card>, folded: ReadonlySet<CardStatus>): ReadonlyArray<ListRow> =>
  cardStatuses.flatMap((status) => {
    const cards = visible.filter((card) => card.standing.status === status)
    if (cards.length === 0) return []
    const group: ListRow = { kind: "group", status, count: cards.length }
    return [group, ...unfoldedCards(cards, folded).map((card): ListRow => ({ kind: "card", card }))]
  })

const noMatch = (shown: RunsShown, all: ReadonlyArray<Card>, act: RunsActions): AlertShown => {
  const words = findWords(shown)
  const wider = filterCards(all, { project: null, allRuns: true }, words).length > 0 && (shown.filter.project !== null || !shown.filter.allRuns)
  const actions: ReadonlyArray<AlertAction> = [
    ...(words === "" ? [] : [{ id: "clear-find", label: "Clear the find", press: act.clearFind }]),
    ...(wider ? [{ id: "show-all-runs", label: "Show all runs", press: (cx: Context) => act.setFilter(cx, { project: null, allRuns: true }) }] : [])
  ]
  return words === ""
    ? { tone: "neutral", title: `No run in ${shown.filter.project ?? "the configured projects"}`, actions }
    : { tone: "neutral", title: `Nothing matches “${words}”`, actions }
}

const listBody = (shown: RunsShown, act: RunsActions): ListBody => {
  const list = shown.list
  if (list.kind === "reading") return { notes: [{ key: "reading", shown: { tone: "info", title: "Reading the runs", body: "orc runs --json --local" } }], rows: [] }
  if (list.kind === "failed") {
    return { notes: [{ key: "failed", shown: { tone: "error", title: "Could not read the runs", body: list.reason, actions: [{ id: "retry", label: "Retry", press: act.retry }] } }], rows: [] }
  }
  const reread: ReadonlyArray<Note> = list.reread === null ? [] : [{ key: "reread", shown: { tone: "error", title: "Could not reread the runs", body: rereadBody(list.reread), actions: [{ id: "retry", label: "Retry", press: act.retry }] } }]
  if (list.cards.length === 0) {
    return { notes: [...reread, { key: "empty", shown: { tone: "neutral", title: "No runs on this machine yet", body: "The beat starts a run from a task in the backlog. Add one with orc backlog add." } }], rows: [] }
  }
  const visible = filterCards(list.cards, shown.filter, findWords(shown))
  if (visible.length === 0) return { notes: [...reread, { key: "no-match", shown: noMatch(shown, list.cards, act) }], rows: [] }
  return { notes: reread, rows: groupRows(visible, shown.foldedGroups) }
}

const shownRow = (shown: RunsShown) => (row: ListRow): ShownRow =>
  row.kind === "group" ? row : { ...row, facts: rowFacts(row.card, row.card.runId === null ? null : shown.facts.get(row.card.runId) ?? null, shown.now) }

const rowKey = (row: ShownRow): string => row.kind === "group" ? `group-${row.status}` : `card-${row.card.key}`

const pickRow = (act: RunsActions) => (row: ShownRow, cx: Context): void => {
  if (row.kind === "group") act.toggleGroup(cx, row.status)
  else act.select(cx, row.card.key)
}

const groupView = (t: Palette, status: CardStatus, count: number, folded: boolean): Element =>
  h_flex().id(`group-${status}`).h(rowHeight).px(8).gap(6).items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
    .hover((style) => style.text_color(t.foreground))
    .child(`${status} (${count.toString()})`)
    .children(folded ? [div().text_color(t.dim).child("▸")] : [])

const cardView = (t: Palette, card: Card, facts: RowFacts, selected: boolean): Element =>
  h_flex().id(`card-${card.key}`).h(rowHeight).px(8).gap(8).items_center().rounded(6).text_size(13).cursor_pointer()
    .when(selected, (row) => row.bg(t.selected))
    .hover((style) => style.bg(selected ? t.selected : zinc.s2))
    .child(statusDot(card.standing.status).tooltip(card.standing.status))
    .child(vendorLogo(facts.vendor))
    .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(facts.title))
    .child(div().flex_none().text_size(12).text_color(t.muted).child(facts.waits ?? facts.model ?? ""))
    .child(div().w(30).flex_none().flex().justify_end().text_size(12).text_color(t.muted).child(facts.duration ?? ""))

const listRow = (t: Palette, shown: RunsShown, row: ShownRow): Element =>
  row.kind === "group"
    ? groupView(t, row.status, row.count, shown.foldedGroups.has(row.status))
    : cardView(t, row.card, row.facts, row.card.key === shown.selectedKey)

const notesView = (t: Palette, notes: ReadonlyArray<Note>): ReadonlyArray<Element> =>
  notes.length === 0 ? [] : [v_flex().px(12).pt(12).gap(8).flex_none().children(notes.map((note) => alert(t, `list-${note.key}`, note.shown)))]

const attentionView = (t: Palette, shown: RunsShown): ReadonlyArray<Element> =>
  shown.agentAttention === undefined ? [] : [v_flex().id("agent-attention-scroll").flex_none().max_h(320).overflow_y_scroll().px(12).py(8).border_t(1).border_color(t.border).children(shown.agentAttention())]

const menuList = (t: Palette, all: ReadonlyArray<Card>, filter: Filter, top: number, act: RunsActions): Element => {
  const menu = projectMenu(all, filter)
  return v_flex().id("filter-project-menu").absolute().top(top).right(headerPadding).w(menuWidth).max_h(320).overflow_y_scrollbar()
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_mouse_down_out((_event, cx) => act.openMenu(cx, false))
    .p(4).gap(2).rounded(12).border(1).border_color(zinc.borderAccent).bg(zinc.s1).shadow_md()
    .children(menu.choices.map((choice) => {
      const chosen = choice === menu.chosen
      return h_flex().id(`filter-project-${choice.name}`).h(28).px(8).gap(8).items_center().rounded(8).justify_between().cursor_pointer()
        .text_color(chosen ? t.foreground : zinc.muted)
        .when(chosen, (row) => row.bg(zinc.s2))
        .hover((style) => style.bg(zinc.s2).text_color(t.foreground))
        .on_click((_event, cx) => act.setFilter(cx, choice.value))
        .child(div().min_w_0().truncate().child(choice.name))
        .child(div().flex_shrink_0().text_color(zinc.muted).child(choice.count.toString()))
    }))
}

const controlHeight = 32
const titleRow = 28
const headerTop = 10
const headerGap = 8

const header = (t: Palette, all: ReadonlyArray<Card>, shown: RunsShown, act: RunsActions): Element =>
  v_flex().px(headerPadding).pt(headerTop).pb(8).gap(headerGap).border_b(1).border_color(t.border)
    .child(h_flex().h(titleRow).items_center().justify_between()
      .child(div().text_size(15).font_semibold().child("Runs"))
      .child(button(t, "fold", "«", "ghost", 24, act.toggleFold)))
    .child(h_flex().gap(8).items_center()
      .child(field(shown.find, controlHeight))
      .child(selectTrigger(t, "filter-project", `Project: ${projectMenu(all, shown.filter).chosen.name}`, controlHeight, (cx) => act.openMenu(cx, !shown.menuOpen))))

const rail = (t: Palette, shown: RunsShown, act: RunsActions): Element => {
  const cards = shown.list.kind === "ok" ? unfoldedCards(filterCards(shown.list.cards, shown.filter, findWords(shown)), shown.foldedGroups) : []
  return v_flex().id("rail").w(railWidth).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
    .child(h_flex().h(titleRow + headerTop * 2).px(8).items_center().child(button(t, "unfold", "»", "ghost", 24, act.toggleFold)))
    .child(uniformRows("rail-ids", cards, (card) => card.key, (card) =>
      h_flex().id(`rail-${card.key}`).h(rowHeight).px(6).gap(6).items_center().rounded(6).cursor_pointer()
        .when(card.key === shown.selectedKey, (row) => row.bg(t.selected))
        .hover((style) => style.bg(card.key === shown.selectedKey ? t.selected : zinc.s2))
        .child(statusDot(card.standing.status).tooltip(card.standing.status))
        .child(div().min_w_0().truncate().child(railLabel(card))), { x: 6, y: 0 }, (card, cx) => act.select(cx, card.key)))
}

export const runsColumn = (t: Palette, shown: RunsShown, act: RunsActions): Element => {
  if (shown.folded) return rail(t, shown, act)
  const all = shown.list.kind === "ok" ? shown.list.cards : []
  const body = listBody(shown, act)
  return v_flex().relative().w(listWidth).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
    .child(header(t, all, shown, act))
    .children(notesView(t, body.notes))
    .child(uniformRows("cards", body.rows.map(shownRow(shown)), rowKey, (row) => listRow(t, shown, row), { x: 6, y: 6 }, pickRow(act)))
    .children(attentionView(t, shown))
    .children(shown.menuOpen ? [menuList(t, all, shown.filter, headerTop + titleRow + headerGap + controlHeight + 4, act)] : [])
}
