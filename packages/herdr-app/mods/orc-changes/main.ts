import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { Scrollbar, h_flex, v_flex, v_virtual_list } from "gpui-base"
import { settings, shared } from "herdr"
import { type ChangedFile, type DiffRow, type RunChanges, changeTotals, changesKey, diffRows, runChanges } from "../../src/changes"
import { readDiff } from "../../src/changes-read"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"

type Palette = ReturnType<typeof palette>

interface Diff {
  readonly of: string
  readonly reading: Reading<ReadonlyArray<DiffRow>>
  readonly width: number
}

const everyMs = 1000
const rowHeight = 20
const fileHeight = 28
const glyphWidth = 7

const monospace = (): string => {
  const family = settings()["font_family"]
  return typeof family === "string" ? family : "Menlo"
}

const heldChanges = (): Reading<RunChanges | null> => {
  const value = shared(changesKey)
  if (value === null || value === undefined) return { kind: "ok", value: null }
  const held = runChanges(value, changesKey)
  return held.kind === "ok" ? { kind: "ok", value: held.value } : { kind: "failed", reason: held.reason }
}

const diffKey = (changes: RunChanges, file: ChangedFile): string =>
  [changes.worktree, changes.base, changes.branch, JSON.stringify(file)].join("\n")

const folderAndName = (path: string): { readonly folder: string; readonly name: string } => {
  const cut = path.lastIndexOf("/") + 1
  return { folder: path.slice(0, cut), name: path.slice(cut) }
}

export default class OrcChanges extends View {
  openPath: string | null = null
  diff: Diff | null = null
  busy = false

  override init(_props: unknown, cx: AsyncContext): void {
    this.follow(cx)
    cx.timer.every(everyMs, (tick) => this.follow(tick))
  }

  openFile(changes: RunChanges): ChangedFile | null {
    return changes.files.find((file) => file.path === this.openPath) ?? changes.files.at(0) ?? null
  }

  follow(cx: AsyncContext): void {
    const held = heldChanges()
    const changes = held.kind === "ok" ? held.value : null
    const file = changes === null ? null : this.openFile(changes)
    if (changes === null || file === null) {
      this.diff = null
      return
    }
    const of = diffKey(changes, file)
    if (this.busy || this.diff?.of === of) return
    this.busy = true
    cx.spawn((task) => readDiff(changes, file.path).then((reading) => {
      this.busy = false
      if (reading.kind !== "ok") {
        this.diff = { of, reading, width: 0 }
      } else {
        const rows = diffRows(reading.value)
        let longest = 0
        for (const row of rows) {
          if (row.text.length > longest) longest = row.text.length
        }
        this.diff = { of, reading: { kind: "ok", value: rows }, width: (longest + 2) * glyphWidth }
      }
      task.notify()
    }))
  }

  pick(cx: Context, path: string): void {
    this.openPath = path
    cx.notify()
  }

  render(): Element {
    const t = palette()
    const held = heldChanges()
    const column = v_flex().id("root").size_full().min_h_0().bg(t.background).border_l(1).border_color(t.border).text_size(13).text_color(t.foreground)
    if (held.kind !== "ok") {
      return column.child(div().p(12).text_color(t.blocked).child(held.kind === "failed" ? `The run's changes cannot be read: ${held.reason}` : "Reading the run's changes"))
    }
    const changes = held.value
    if (changes === null) {
      return column.child(div().p(12).text_color(t.muted).child("This run changed no file"))
    }
    const open = this.openFile(changes)
    const totals = changeTotals(changes.files)
    return column
      .child(h_flex().h(44).flex_shrink_0().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(15).font_semibold().child("Changes"))
        .child(div().text_size(12).text_color(t.dim).child(changes.files.length === 1 ? "1 file" : `${changes.files.length.toString()} files`))
        .child(div().flex_1())
        .child(div().text_size(12).text_color(t.ansi2).child(`+${totals.added.toString()}`))
        .child(div().text_size(12).text_color(t.ansi1).child(`−${totals.deleted.toString()}`)))
      .child(v_flex().id("files").flex_shrink_0().max_h(fileHeight * 8 + 12).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .children(changes.files.map((file) => this.fileRow(t, file, file.path === open?.path))))
      .child(this.diffPane(t, open === null ? null : diffKey(changes, open)))
  }

  fileRow(t: Palette, file: ChangedFile, selected: boolean): Element {
    const { folder, name } = folderAndName(file.path)
    const counts = file.change.kind === "binary"
      ? [div().flex_shrink_0().text_size(12).text_color(t.dim).child("binary")]
      : [
        div().flex_shrink_0().text_size(12).text_color(t.ansi2).child(`+${file.change.added.toString()}`),
        div().flex_shrink_0().text_size(12).text_color(t.ansi1).child(`−${file.change.deleted.toString()}`)
      ]
    return h_flex().id(`file-${file.path}`).h(fileHeight).flex_shrink_0().px(8).gap(8).items_center().rounded(4).cursor_pointer()
      .bg(selected ? t.selected : t.background)
      .hover((style) => style.bg(selected ? t.selected : t.hover))
      .on_click((_event, cx) => this.pick(cx, file.path))
      .child(h_flex().flex_1().min_w_0()
        .child(div().min_w_0().truncate().text_color(t.dim).child(folder))
        .child(div().flex_shrink_0().child(name)))
      .children(counts)
  }

  diffPane(t: Palette, of: string | null): Element {
    const current = this.diff !== null && this.diff.of === of ? this.diff : null
    const reading: Reading<ReadonlyArray<DiffRow>> = current ?? { kind: "reading" }
    const note = (text: string, failed: boolean): Element => div().p(12).text_color(failed ? t.blocked : t.muted).child(text)
    if (reading.kind === "reading") return note("Reading the file's diff", false)
    if (reading.kind === "failed") return note(reading.reason, true)
    const rows = reading.value
    if (rows.length === 0) return note("This file has no text diff", false)
    const width = current?.width ?? 0
    return div().flex_1().min_h_0().relative().font_family(monospace()).text_size(12)
      .child(div().id("diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(width).h_full()
          .child(v_virtual_list("diff", rows.length, rowHeight, (index) => index.toString(),
            (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(t, row))).size_full())))
      .child(Scrollbar.vertical("diff").viewport_from_layout().absolute().inset_0())
  }

  diffRow(t: Palette, row: DiffRow): Element {
    const line = div().w_full().h(rowHeight).flex_none().px(12).truncate()
    switch (row.kind) {
      case "hunk":
        return line.bg(t.raised).text_color(t.dim).child(row.text)
      case "added":
        return line.bg(`${t.ansi2}18`).child(row.text)
      case "deleted":
        return line.bg(`${t.ansi1}18`).child(row.text)
      case "context":
        return line.child(row.text === "" ? " " : row.text)
    }
  }
}
