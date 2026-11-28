import { type Context, type Element, div, uniform_list } from "gpui-kit"
import { Scrollbar, v_flex } from "gpui-base"

interface RowInset {
  readonly x: number
  readonly y: number
}

// A scrolling div builds every row on each scroll frame, and list enters the script once per visible row on every frame, which a spinner on screen makes every frame. uniform_list enters it once per frame.
// The App refuses a handler registered inside a row, so a row holds no button and a press reaches pick through the list.
// Every row must be the same height, because uniform_list places them all by the first one.
export const uniformRows = <A>(id: string, rows: ReadonlyArray<A>, keyOf: (row: A) => string, renderRow: (row: A) => Element, inset: RowInset, pick: (row: A, cx: Context) => void): Element => {
  const drawn = uniform_list(id, rows.length, (index) => { const row = rows[index]; return row === undefined ? String(index) : keyOf(row) }, (range) =>
    rows.slice(range.start, range.end).map((row) => v_flex().w_full().min_w_0().px(inset.x).child(renderRow(row)))).size_full()
  const byKey = new Map(rows.map((row) => [keyOf(row), row]))
  return div().flex_1().min_h_0().relative().py(inset.y)
    .child(drawn.on_item_click((key, cx) => { const row = byKey.get(key); if (row !== undefined) pick(row, cx) }))
    .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0())
}
