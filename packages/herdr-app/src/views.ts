import type { AsyncContext, Context } from "gpui-kit"
import { layout, run } from "herdr"

export const viewsStack = "orc-views"
export const selectedTaskKey = "orc.board.selected"
export const agentsOpenKey = "orc.agents.open"

export interface OpenAsk {
  readonly run: string
  readonly at: number
}

export const openAsk = (value: unknown): OpenAsk | null =>
  isRecord(value) && typeof value["run"] === "string" && typeof value["at"] === "number" ? { run: value["run"], at: value["at"] } : null

export const views = [
  { id: "orc-board", label: "Board", key: "⌘1" },
  { id: "orc-resources", label: "Resources", key: "⌘2" },
  { id: "orc-agents", label: "Agents", key: "⌘3" },
  { id: "orc-inbox", label: "Inbox", key: "⌘4" }
] as const

const inboxSelect = { command: "layout.select", args: { stack: viewsStack, child: "orc-inbox" } } as const

export const openInbox = (cx: Context): void => {
  cx.stop_propagation()
  run(inboxSelect.command, inboxSelect.args)
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface Refreshed<T> {
  lastRead: number
  busy: boolean
  stale?: boolean
  reading: T
  load: () => Promise<T>
}

export interface ShownRefresh<T> extends Refreshed<T> {
  visible: boolean
}

const refreshInto = <T>(host: Refreshed<T>, spot: AsyncContext): void => {
  if (host.busy) return
  host.busy = true
  host.lastRead = Date.now()
  spot.spawn((task) => host.load().then((reading) => {
    host.reading = reading
    host.busy = false
    if (host.stale === true) {
      host.stale = false
      refreshInto(host, task)
    } else {
      task.notify()
    }
  }))
}

export const refreshInBackground = <T>(everyMs: number, cx: AsyncContext, host: Refreshed<T>): void => {
  cx.timer.every(1000, (tick) => {
    if (Date.now() - host.lastRead >= everyMs) refreshInto(host, tick)
  })
  refreshInto(host, cx)
}

export const refreshWhenShown = <T>(view: string, everyMs: number, cx: AsyncContext, host: ShownRefresh<T>): void => {
  const refresh = (spot: AsyncContext): void => refreshInto(host, spot)
  const shown = (): boolean => {
    const active = activeChild(layout(), viewsStack)
    return active === null || active === view
  }
  cx.timer.every(1000, (tick) => {
    const nowShown = shown()
    if (nowShown && (!host.visible || Date.now() - host.lastRead >= everyMs)) refresh(tick)
    host.visible = nowShown
  })
  if (shown()) {
    host.visible = true
    refresh(cx)
  }
}

export const reloadNow = <T>(cx: Context, host: ShownRefresh<T>): void => {
  if (host.busy) {
    host.stale = true
    return
  }
  host.busy = true
  cx.spawn((task) => host.load().then((reading) => {
    host.reading = reading
    host.busy = false
    if (host.stale === true) {
      host.stale = false
      reloadNow(task, host)
    }
    task.notify()
  }))
}

export const activeChild = (node: unknown, stack: string): string | null => {
  if (!isRecord(node)) {
    return null
  }
  if (node["id"] === stack) {
    return typeof node["active"] === "string" ? node["active"] : null
  }
  const children = Array.isArray(node["children"]) ? node["children"] : []
  for (const child of children) {
    const found = activeChild(child, stack)
    if (found !== null) {
      return found
    }
  }
  return null
}
