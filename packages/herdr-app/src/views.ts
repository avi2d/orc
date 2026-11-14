import type { AsyncContext } from "gpui-kit"
import { layout } from "herdr"

export const viewsStack = "orc-views"

export const views = [
  { id: "orc-board", label: "Board", key: "⌘1" },
  { id: "orc-resources", label: "Resources", key: "⌘2" },
  { id: "orc-agents", label: "Agents", key: "⌘3" }
] as const

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface ShownRefresh<T> {
  visible: boolean
  lastRead: number
  busy: boolean
  reading: T
  load: () => Promise<T>
}

export const refreshWhenShown = <T>(view: string, everyMs: number, cx: AsyncContext, host: ShownRefresh<T>): void => {
  const refresh = (spot: AsyncContext): void => {
    if (host.busy) return
    host.busy = true
    host.lastRead = Date.now()
    spot.spawn((task) => host.load().then((reading) => {
      host.reading = reading
      host.busy = false
      task.notify()
    }))
  }
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
