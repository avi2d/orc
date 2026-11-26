import { type Context, type Element, div, list } from "gpui-kit"
import { Scrollbar, v_flex } from "gpui-base"

interface RowSpacing {
  readonly x: number
  readonly y: number
  readonly gap: number
}

// A scroll re-renders the whole view, and a scrolling div builds and lays out every row on each of those frames, where list builds only the rows on screen.
export const rowsList = <A>(id: string, rows: ReadonlyArray<A>, keyOf: (row: A) => string, renderRow: (row: A, cx: Context) => Element, spacing: RowSpacing): Element =>
  div().flex_1().min_h_0().relative()
    .child(list(id, rows.length, (index) => { const row = rows[index]; return row === undefined ? String(index) : keyOf(row) }, (index, cx) => {
      const row = rows[index]
      const spaced = v_flex().w_full().min_w_0().px(spacing.x).pt(index === 0 ? spacing.y : 0).pb(index === rows.length - 1 ? spacing.y : spacing.gap)
      return row === undefined ? spaced : spaced.child(renderRow(row, cx))
    }).size_full())
    .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0())
