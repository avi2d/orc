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

const call = (scroll: ScrollHandle, name: "offset" | "viewport_size"): unknown => {
  const method: unknown = Reflect.get(scroll, name)
  return typeof method === "function" ? Reflect.apply(method, scroll, []) : null
}

const viewport = (scroll: ScrollHandle) => {
  const size = call(scroll, "viewport_size")
  const width = metric(size, "width")
  const height = metric(size, "height")
  const offset = metric(call(scroll, "offset"), "y")
  return !width || !height || offset === null ? null : { width, height, offset }
}

interface Band {
  readonly from: number
  readonly to: number
}

export class InboxScroll {
  private heights = new Map<string, number>()
  private band: Band | null = null
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
    const band = view === null ? null : { from: view.offset - view.height, to: view.offset + 2 * view.height }
    this.band = null
    const heights = this.heights
    let top: number | null = inboxPadding
    return (key: string, draw: () => Element): Element => {
      const height = heights.get(key)
      const start: number | null = top
      top = start === null || height === undefined ? null : start + height + inboxGap
      if (band !== null && start !== null && height !== undefined && (start + height < band.from || start > band.to)) {
        this.band = band
        return div().id(`space-${key}`).flex_shrink_0().h(height)
      }
      // Interactive rows cannot register input handlers inside a native virtual list.
      return draw().on_size_change((size) => { if (size.height > 0) heights.set(key, size.height / zoom) })
    }
  }

  // Native scrolling does not invalidate the view, so a poll has to notice the viewport nearing a spacer.
  leftDrawnBand(scroll: ScrollHandle): boolean {
    const band = this.band
    const view = viewport(scroll)
    return band !== null && view !== null &&
      (view.offset < band.from + view.height / 2 || view.offset + view.height * 1.5 > band.to)
  }
}
