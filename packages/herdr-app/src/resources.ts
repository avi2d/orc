import { type Guard, type Guarded, arrayOf, child, fields, literal, number, ok, string } from "./guard"

export type Known<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "failed"; readonly reason: string }

type Fields = Readonly<Record<string, unknown>>

const failed = (reason: string): { readonly kind: "failed"; readonly reason: string } => ({ kind: "failed", reason })

const outcome = <A>(record: Fields, name: string, at: string, value: Guard<A>): Guarded<Known<A>> => {
  const where = child(at, name)
  const holder = fields(record[name], where)
  if (holder.kind === "refused") return holder
  const kind = holder.value["kind"]
  if (kind === "unreachable" || kind === "invalid") {
    const reason = string(holder.value, kind === "unreachable" ? "reason" : "issue", where)
    if (reason.kind === "refused") return reason
    return ok(failed(reason.value))
  }
  const shown = literal(holder.value, "kind", where, "ok")
  if (shown.kind === "refused") return shown
  const inner = value(holder.value["value"], child(where, "value"))
  if (inner.kind === "refused") return inner
  return ok({ kind: "ok", value: inner.value })
}

const answer = <A>(value: unknown, at: string, body: (record: Fields, at: string) => Guarded<A>): Guarded<Known<A>> => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  if (record.value["status"] === "failed") {
    const error = string(record.value, "error", at)
    if (error.kind === "refused") return error
    return ok(failed(error.value))
  }
  const status = literal(record.value, "status", at, "ok")
  if (status.kind === "refused") return status
  const inner = body(record.value, at)
  if (inner.kind === "refused") return inner
  return ok({ kind: "ok", value: inner.value })
}

export interface QuotaWindow {
  readonly account: string
  readonly label: string
  readonly startsAt: string
  readonly resetsAt: string
  readonly usedPoints: number
  readonly leftPoints: number
  readonly elapsedFraction: number
}

const quotaWindow: Guard<QuotaWindow> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const account = fields(record.value["account"], child(at, "account"))
  if (account.kind === "refused") return account
  const title = string(account.value, "title", child(at, "account"))
  if (title.kind === "refused") return title
  const label = string(record.value, "label", at)
  if (label.kind === "refused") return label
  const startsAt = string(record.value, "startsAt", at)
  if (startsAt.kind === "refused") return startsAt
  const resetsAt = string(record.value, "resetsAt", at)
  if (resetsAt.kind === "refused") return resetsAt
  const usedPoints = number(record.value, "usedPoints", at)
  if (usedPoints.kind === "refused") return usedPoints
  const leftPoints = number(record.value, "leftPoints", at)
  if (leftPoints.kind === "refused") return leftPoints
  const elapsedFraction = number(record.value, "elapsedFraction", at)
  if (elapsedFraction.kind === "refused") return elapsedFraction
  return ok({
    account: title.value,
    label: label.value,
    startsAt: startsAt.value,
    resetsAt: resetsAt.value,
    usedPoints: usedPoints.value,
    leftPoints: leftPoints.value,
    elapsedFraction: elapsedFraction.value
  })
}

export interface Bytes {
  readonly usedBytes: number
  readonly totalBytes: number
}

export interface Machine {
  readonly cores: Known<number>
  readonly load: Known<number>
  readonly memory: Known<Bytes>
  readonly disk: Known<Bytes>
}

const bytes: Guard<Bytes> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const usedBytes = number(record.value, "usedBytes", at)
  if (usedBytes.kind === "refused") return usedBytes
  const totalBytes = number(record.value, "totalBytes", at)
  if (totalBytes.kind === "refused") return totalBytes
  return ok({ usedBytes: usedBytes.value, totalBytes: totalBytes.value })
}

const cores: Guard<number> = (value, at) => {
  const record = fields(value, at)
  return record.kind === "refused" ? record : number(record.value, "cores", at)
}

const oneMinuteLoad: Guard<number> = (value, at) => {
  if (!Array.isArray(value) || value.length !== 3) {
    return { kind: "refused", reason: `${at} is ${JSON.stringify(value)}, not three load averages` }
  }
  return number({ first: value[0] }, "first", at)
}

const machine: Guard<Machine> = (value, at) => {
  const report = fields(value, at)
  if (report.kind === "refused") return report
  const where = child(at, "machine")
  const host = fields(report.value["machine"], where)
  if (host.kind === "refused") return host
  const cpu = outcome(host.value, "cpu", where, cores)
  if (cpu.kind === "refused") return cpu
  const load = outcome(host.value, "load", where, oneMinuteLoad)
  if (load.kind === "refused") return load
  const memory = outcome(host.value, "memory", where, bytes)
  if (memory.kind === "refused") return memory
  const disk = outcome(host.value, "disk", where, bytes)
  if (disk.kind === "refused") return disk
  return ok({ cores: cpu.value, load: load.value, memory: memory.value, disk: disk.value })
}

export interface Named<A> {
  readonly name: string
  readonly reading: Known<A>
}

const named = <A>(key: string, body: Guard<A>): Guard<Named<A>> => (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const name = string(record.value, "name", at)
  if (name.kind === "refused") return name
  const reading = outcome(record.value, key, at, body)
  if (reading.kind === "refused") return reading
  return ok({ name: name.value, reading: reading.value })
}

const group: Guard<string> = (value, at) => {
  const record = fields(value, at)
  return record.kind === "refused" ? record : string(record.value, "group", at)
}

const runningGroups: Guard<ReadonlyArray<string>> = (value, at) => {
  const record = fields(value, at)
  return record.kind === "refused" ? record : arrayOf(record.value, "running", at, group)
}

const windowsOf = (record: Fields, at: string): Guarded<ReadonlyArray<QuotaWindow>> => {
  const report = fields(record["report"], child(at, "report"))
  if (report.kind === "refused") return report
  return arrayOf(report.value, "windows", child(at, "report"), quotaWindow)
}

export type Queues = ReadonlyArray<Named<ReadonlyArray<string>>>

export interface ResourcesSnapshot {
  readonly windows: Known<ReadonlyArray<QuotaWindow>>
  readonly machines: Known<ReadonlyArray<Named<Machine>>>
  readonly queues: Known<Queues>
}

export const resourcesSnapshot: Guard<ResourcesSnapshot> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const version = literal(record.value, "schemaVersion", at, 1)
  if (version.kind === "refused") return version
  const where = child(at, "sources")
  const sources = fields(record.value["sources"], where)
  if (sources.kind === "refused") return sources
  const windows = answer(sources.value["quota"], child(where, "quota"), windowsOf)
  if (windows.kind === "refused") return windows
  const machines = answer(sources.value["resources"], child(where, "resources"), (r, a) => arrayOf(r, "machines", a, named("reading", machine)))
  if (machines.kind === "refused") return machines
  const queues = answer(sources.value["queues"], child(where, "queues"), (r, a) => arrayOf(r, "machines", a, named("pueue", runningGroups)))
  if (queues.kind === "refused") return queues
  return ok({ windows: windows.value, machines: machines.value, queues: queues.value })
}

const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

export const countdown = (left: number): string => {
  if (left < minuteMs) return "now"
  if (left >= dayMs) {
    return `${Math.floor(left / dayMs)}d ${Math.floor((left % dayMs) / hourMs)}h`
  }
  return `${Math.floor(left / hourMs)}h ${Math.floor((left % hourMs) / minuteMs)}m`
}

const usedShare = (window: QuotaWindow): number => {
  const total = window.usedPoints + window.leftPoints
  return total === 0 ? 0 : window.usedPoints / total
}

export const pastPace = (window: QuotaWindow): boolean => usedShare(window) > window.elapsedFraction

// At a steady pace the window empties at start + elapsed / usedShare, which is before the reset exactly when pastPace holds.
export const runsOutAt = (window: QuotaWindow): number | null => {
  if (!pastPace(window)) return null
  const start = Date.parse(window.startsAt)
  const elapsed = window.elapsedFraction * (Date.parse(window.resetsAt) - start)
  return start + elapsed / usedShare(window)
}

export interface WindowRow {
  readonly label: string
  readonly usedPercent: number
  readonly filled: number
  readonly notch: number
  readonly red: boolean
  readonly resets: string
  readonly runsOut: string | null
}

export interface AccountRows {
  readonly account: string
  readonly windows: ReadonlyArray<WindowRow>
}

const share = (fraction: number): number => Math.min(1, Math.max(0, fraction))

const windowRow = (window: QuotaWindow, now: number): WindowRow => {
  const resetsAt = Date.parse(window.resetsAt)
  const runsOut = resetsAt > now ? runsOutAt(window) : null
  return {
    label: window.label,
    usedPercent: Math.round(usedShare(window) * 100),
    filled: share(usedShare(window)),
    notch: share(window.elapsedFraction),
    red: pastPace(window),
    resets: countdown(resetsAt - now),
    runsOut: runsOut === null ? null : countdown(runsOut - now)
  }
}

export const subscriptionRows = (windows: ReadonlyArray<QuotaWindow>, now: number): ReadonlyArray<AccountRows> => {
  const accounts = new Map<string, Array<WindowRow>>()
  for (const window of windows) {
    const rows = accounts.get(window.account) ?? []
    rows.push(windowRow(window, now))
    accounts.set(window.account, rows)
  }
  return [...accounts].map(([account, rows]) => ({ account, windows: rows }))
}

export type Cell =
  | { readonly kind: "value"; readonly text: string; readonly alert: boolean }
  | { readonly kind: "failed"; readonly reason: string }

export interface MachineRow {
  readonly name: string
  readonly cores: Cell
  readonly load: Cell
  readonly memory: Cell
  readonly disk: Cell
  readonly runs: Cell
}

export const machineCells = [["Cores", "cores"], ["Load", "load"], ["Memory", "memory"], ["Disk", "disk"], ["Orc runs", "runs"]] as const

const readingCells = machineCells.filter(([, key]) => key !== "runs").length

export const unreadLines = (rows: ReadonlyArray<MachineRow>): ReadonlyArray<string> =>
  rows.flatMap((row) => {
    const byReason = new Map<string, Array<string>>()
    for (const [label, key] of machineCells) {
      const cell = row[key]
      if (cell.kind === "failed") byReason.set(cell.reason, [...(byReason.get(cell.reason) ?? []), label.toLowerCase()])
    }
    return [...byReason].map(([reason, cells]) =>
      cells.length >= readingCells ? `${row.name}: ${reason}` : `${row.name} ${cells.join(", ")}: ${reason}`)
  })

const gib = 1024 ** 3

const plain = (text: string): Cell => ({ kind: "value", text, alert: false })

const cellOf = <A>(known: Known<A>, cell: (value: A) => Cell): Cell => known.kind === "ok" ? cell(known.value) : known

const bytesCell = (known: Known<Bytes>): Cell =>
  cellOf(known, ({ usedBytes, totalBytes }) => plain(`${Math.round(usedBytes / gib)} / ${Math.round(totalBytes / gib)} GiB`))

export const orcGroup = "orc"

const runsCell = (name: string, queues: Known<Queues>): Cell => {
  if (queues.kind === "failed") return queues
  const queue = queues.value.find((entry) => entry.name === name)
  if (queue === undefined) return failed(`the queues report has no machine named ${name}`)
  return cellOf(queue.reading, (groups) => plain(String(groups.filter((entry) => entry === orcGroup).length)))
}

export const machineRows = (machines: ReadonlyArray<Named<Machine>>, queues: Known<Queues>): ReadonlyArray<MachineRow> =>
  machines.map(({ name, reading }) => {
    const runs = runsCell(name, queues)
    if (reading.kind === "failed") {
      return { name, cores: reading, load: reading, memory: reading, disk: reading, runs }
    }
    const { cores, load, memory, disk } = reading.value
    return {
      name,
      cores: cellOf(cores, (count) => plain(String(count))),
      load: cellOf(load, (one) => ({ kind: "value", text: one.toFixed(2), alert: cores.kind === "ok" && one > cores.value })),
      memory: bytesCell(memory),
      disk: bytesCell(disk),
      runs
    }
  })
