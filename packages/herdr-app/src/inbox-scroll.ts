import { type Element, div } from "gpui-kit"
import type { ScrollHandle } from "gpui-base"
import { settings } from "herdr"
import type { InboxItem } from "./inbox"

export const inboxPadding = 16
export const inboxGap = 12

const metric = (value: unknown, key: string): number | null => {
  if (typeof value !== "object" || value === null) return null
  const field: unknown = Reflect.get(value, key)
  return typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : null
}

const viewport = (scroll: ScrollHandle) => {
  if (!("offset" in scroll) || typeof scroll.offset !== "function" || !("viewport_size" in scroll) || typeof scroll.viewport_size !== "function") return null
  const size: unknown = scroll.viewport_size()
  const width = metric(size, "width")
  const height = metric(size, "height")
  const offset = metric(scroll.offset(), "y")
  return !width || !height || offset === null ? null : { width, height, offset }
}

export class InboxScroll {
  private heights = new Map<string, number>()
  private items: ReadonlyArray<InboxItem> | null = null
  private width = 0
  private zoom = 1

  rows(scroll: ScrollHandle, items: ReadonlyArray<InboxItem>) {
    if (this.items !== items) {
      this.items = items
      const keys = new Set(items.map((item) => item.key))
      this.heights = new Map([...this.heights].filter(([key]) => keys.has(key)))
    }
    const view = viewport(scroll)
    const setting = settings()["zoom"]
    const zoom = typeof setting === "number" && setting > 0 ? setting : 1
    if (view !== null && (this.width !== view.width || this.zoom !== zoom)) {
      if (this.width !== 0 || this.zoom !== zoom) this.heights.clear()
      this.width = view.width
      this.zoom = zoom
    }
    const heights = this.heights
    let top: number | null = inboxPadding
    return (key: string, draw: () => Element): Element => {
      const height = heights.get(key)
      const start: number | null = top
      top = start === null || height === undefined ? null : start + height + inboxGap
      if (view !== null && start !== null && height !== undefined &&
        (start + height < view.offset - view.height || start > view.offset + 2 * view.height)) {
        return div().id(`space-${key}`).flex_shrink_0().h(height)
      }
      // Interactive rows cannot register input handlers inside a native virtual list.
      return draw().on_size_change((size) => { if (size.height > 0) heights.set(key, size.height / zoom) })
    }
  }
}
