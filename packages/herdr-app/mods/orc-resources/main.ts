import { type AsyncContext, type Element, View, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { type Reading, readJson } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type AccountRows, type Cell, type ResourcesSnapshot, type WindowRow, machineCells, machineRows, resourcesSnapshot, subscriptionRows, unreadLines } from "../../src/resources"
import { refreshWhenShown } from "../../src/views"

type Palette = ReturnType<typeof palette>

const everyMs = 60_000
const thisView = "orc-resources"
const args = ["snapshot", "--json", "--only", "quota,resources,queues"]
const barWidth = 120

const column = (width: number, content: Element | string): Element => div().w(width).flex_none().child(content)

const header = (t: Palette, names: ReadonlyArray<readonly [string, number]>): Element =>
  h_flex().gap(16).text_color(t.muted).text_size(12).children(names.map(([name, width]) => column(width, name)))

const bar = (t: Palette, row: WindowRow): Element =>
  div().relative().w(barWidth).h(12).flex_none()
    .child(div().absolute().top(3).left(0).w(barWidth).h(6).rounded(3).bg(t.raised))
    .child(div().absolute().top(3).left(0).w(Math.round(barWidth * row.filled)).h(6).rounded(3).bg(row.red ? t.ansi1 : t.done))
    .child(div().absolute().top(0).left(Math.min(barWidth - 2, Math.round(barWidth * row.notch))).w(2).h(12).bg(t.foreground))

const used = (t: Palette, row: WindowRow): Element =>
  h_flex().gap(8).items_center()
    .child(bar(t, row))
    .child(div().text_color(row.red ? t.ansi1 : t.foreground).child(`${row.usedPercent}%`))

const subscriptionColumns = [["Account", 140], ["Window", 100], ["Used", 180], ["Resets", 80], ["Runs out", 80]] as const

const account = (t: Palette, group: AccountRows): Element =>
  v_flex().gap(4).children(group.windows.map((row, index) =>
    h_flex().h(22).gap(16).items_center()
      .child(column(140, index === 0 ? group.account : ""))
      .child(column(100, row.label))
      .child(column(180, used(t, row)))
      .child(column(80, row.resets))
      .child(column(80, div().text_color(t.ansi1).child(row.runsOut ?? "")))))

const failedLine = (t: Palette, reason: string): Element => div().text_color(t.blocked).child(reason)

const subscriptions = (t: Palette, windows: ResourcesSnapshot["windows"], now: number): Element => {
  if (windows.kind === "failed") return failedLine(t, `orc-dash read no quota: ${windows.reason}`)
  const groups = subscriptionRows(windows.value, now)
  if (groups.length === 0) return div().text_color(t.muted).child("No quota windows in the quota report")
  return v_flex().gap(4)
    .child(header(t, subscriptionColumns))
    .child(v_flex().gap(12).children(groups.map((group) => account(t, group))))
}

const cellWidth = { cores: 60, load: 60, memory: 110, disk: 110, runs: 70 } as const

const machineColumns: ReadonlyArray<readonly [string, number]> = [["Machine", 140], ...machineCells.map(([name, key]) => [name, cellWidth[key]] as const)]

const cellText = (t: Palette, cell: Cell): Element =>
  cell.kind === "failed" ? div().text_color(t.dim).child("—") : div().text_color(cell.alert ? t.ansi1 : t.foreground).child(cell.text)

const machines = (t: Palette, snapshot: ResourcesSnapshot): Element => {
  if (snapshot.machines.kind === "failed") return failedLine(t, `orc-dash read no resources: ${snapshot.machines.reason}`)
  const rows = machineRows(snapshot.machines.value, snapshot.queues)
  return v_flex().gap(4)
    .child(header(t, machineColumns))
    .children(rows.map((row) =>
      h_flex().h(22).gap(16).items_center()
        .child(column(140, row.name))
        .children(machineCells.map(([, key]) => column(cellWidth[key], cellText(t, row[key]))))))
    .children(unreadLines(rows).map((line) => div().pt(4).text_size(12).text_color(t.muted).child(line)))
}

const section = (t: Palette, title: string, body: Element): Element =>
  v_flex().gap(10)
    .child(div().text_size(16).font_semibold().text_color(t.foreground).child(title))
    .child(body)

export default class OrcResources extends View {
  reading: Reading<ResourcesSnapshot> = { kind: "reading" }
  visible = false
  lastRead = 0
  busy = false

  load = (): Promise<Reading<ResourcesSnapshot>> => readJson("orc-dash", args, resourcesSnapshot)

  override init(_props: unknown, cx: AsyncContext): void {
    refreshWhenShown(thisView, everyMs, cx, this)
  }

  render(): Element {
    const t = palette()
    const root = v_flex().id("root").size_full().overflow_y_scroll().bg(t.surface).p(24).gap(28).text_size(14).text_color(t.foreground)
    if (this.reading.kind === "reading") return root.child(div().text_color(t.muted).child(`Reading orc-dash ${args.join(" ")}`))
    if (this.reading.kind === "failed") return root.child(failedLine(t, this.reading.reason))
    const now = Date.now()
    return root
      .child(section(t, "Subscriptions", subscriptions(t, this.reading.value.windows, now)))
      .child(section(t, "Machines", machines(t, this.reading.value)))
  }
}
