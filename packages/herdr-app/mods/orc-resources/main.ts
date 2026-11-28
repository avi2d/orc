import { type AsyncContext, type Element, View, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { readingTime, resourceReading } from "../../src/resource-reading"
import { type Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { type AccountRows, type Cell, type Known, type MachinesSnapshot, type Subscriptions, type WindowRow, machineCells, machineRows, machinesSnapshot, subscriptionRows, subscriptionsSnapshot, unreadLines } from "../../src/resources"
import { refreshInBackground } from "../../src/views"

type Palette = ReturnType<typeof palette>

const everyMs = 60_000
const subscriptionReport = "subscription-overview"
const machineReport = "machine-overview"
const barWidth = 120

const column = (width: number, content: Element | string): Element => div().w(width).flex_none().child(content)

const header = (t: Palette, names: ReadonlyArray<readonly [string, number]>): Element =>
  h_flex().gap(16).text_color(t.muted).text_size(12).children(names.map(([name, width]) => column(width, name)))

const bar = (t: Palette, row: WindowRow): Element =>
  div().relative().w(barWidth).h(12).flex_none()
    .child(div().absolute().top(3).left(0).w(barWidth).h(6).rounded(3).bg(t.raised))
    .child(div().absolute().top(3).left(0).w(Math.round(barWidth * row.filled)).h(6).rounded(3).bg(row.red ? t.ansi1 : t.done))
    .children(row.notch === null ? [] : [div().absolute().top(0).left(Math.min(barWidth - 2, Math.round(barWidth * row.notch))).w(2).h(12).bg(t.foreground)])

const used = (t: Palette, row: WindowRow): Element =>
  h_flex().gap(8).items_center()
    .child(bar(t, row))
    .child(div().text_color(row.red ? t.ansi1 : t.foreground).child(`${row.usedPercent}%`))

const subscriptionColumns = [["Account", 140], ["Window", 100], ["Used", 180], ["Resets", 80], ["Runs out", 80]] as const

const windowRows = (t: Palette, name: string, windows: ReadonlyArray<WindowRow>): Element =>
  v_flex().gap(4).children(windows.map((row, index) =>
    h_flex().h(22).gap(16).items_center()
      .child(column(140, index === 0 ? name : ""))
      .child(column(100, row.label))
      .child(column(180, used(t, row)))
      .child(column(80, row.resets))
      .child(column(80, div().text_color(t.ansi1).child(row.runsOut ?? "")))))

const account = (t: Palette, group: AccountRows): Element =>
  group.kind === "windows"
    ? windowRows(t, group.account, group.windows)
    : h_flex().h(22).gap(16).items_center().child(column(140, group.account)).child(div().text_color(t.blocked).child(group.reason))

const failedLine = (t: Palette, reason: string): Element => div().text_color(t.blocked).child(reason)

const readingLine = (t: Palette, report: string): Element => div().text_color(t.muted).child(`Reading orc-dash report ${report}`)

const subscriptions = (t: Palette, reading: Reading<Known<Subscriptions>>, now: number): Element => {
  if (reading.kind === "reading") return readingLine(t, subscriptionReport)
  if (reading.kind === "failed") return failedLine(t, reading.reason)
  if (reading.value.kind === "failed") return failedLine(t, `orc-dash read no quota: ${reading.value.reason}`)
  const groups = subscriptionRows(reading.value.value, now)
  return v_flex().gap(4)
    .child(groups.length === 0 ? div().text_color(t.muted).child("No accounts in the quota report") : header(t, subscriptionColumns))
    .child(v_flex().gap(12).children(groups.map((group) => account(t, group))))
    .children((reading.value.value.warnings ?? []).map((reason) => failedLine(t, reason)))
}

const cellWidth = { cores: 60, load: 60, memory: 110, disk: 110, runs: 70 } as const

const machineColumns: ReadonlyArray<readonly [string, number]> = [["Machine", 140], ...machineCells.map(([name, key]) => [name, cellWidth[key]] as const)]

const cellText = (t: Palette, cell: Cell): Element =>
  cell.kind === "failed" ? div().text_color(t.dim).child("—") : div().text_color(cell.alert ? t.ansi1 : t.foreground).child(cell.text)

const machines = (t: Palette, reading: Reading<MachinesSnapshot>): Element => {
  if (reading.kind === "reading") return readingLine(t, machineReport)
  if (reading.kind === "failed") return failedLine(t, reading.reason)
  const snapshot = reading.value
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

const section = (t: Palette, title: string, stamp: string | null, body: Element): Element =>
  v_flex().gap(10)
    .child(div().text_size(16).font_semibold().text_color(t.foreground).child(title))
    .children(stamp === null ? [] : [div().text_color(t.muted).text_size(12).child(stamp)])
    .child(body)

export default class OrcResources extends View {
  subscriptions = resourceReading(subscriptionReport, subscriptionsSnapshot)
  machines = resourceReading(machineReport, machinesSnapshot)

  override init(_props: unknown, cx: AsyncContext): void {
    refreshInBackground(everyMs, cx, this.subscriptions)
    refreshInBackground(everyMs, cx, this.machines)
  }

  render(): Element {
    const t = palette()
    return v_flex().id("root").size_full().overflow_y_scroll().bg(t.surface).p(24).gap(28).text_size(14).text_color(t.foreground)
      .child(section(t, "Subscriptions", readingTime(this.subscriptions), subscriptions(t, this.subscriptions.reading, Date.now())))
      .child(section(t, "Machines", readingTime(this.machines), machines(t, this.machines.reading)))
  }
}
