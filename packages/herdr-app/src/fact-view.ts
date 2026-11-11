import { type AsyncContext, type Element, View, div } from "gpui-kit"
import { v_flex } from "gpui-base"
import { palette } from "./palette"
import type { Reading } from "./orc-read"

export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export abstract class FactView<A> extends View {
  abstract readonly title: string
  abstract readonly command: string
  abstract readonly everyMs: number
  abstract read(): Promise<Reading<A>>
  abstract fact(value: A): string

  reading: Reading<A> = { kind: "reading" }
  busy = false

  override init(_props: unknown, cx: AsyncContext): void {
    this.refresh(cx)
    cx.timer.every(this.everyMs, (tick) => this.refresh(tick))
  }

  refresh(cx: AsyncContext): void {
    if (this.busy) {
      return
    }
    this.busy = true
    cx.spawn((task) =>
      this.read().then((reading) => {
        this.reading = reading
        this.busy = false
        task.notify()
      })
    )
  }

  render(): Element {
    const t = palette()
    const line = this.reading.kind === "ok"
      ? div().text_color(t.foreground).child(this.fact(this.reading.value))
      : this.reading.kind === "failed"
      ? div().text_color(t.blocked).child(this.reading.reason)
      : div().text_color(t.muted).child(`Reading ${this.command}`)
    return v_flex().id("root").size_full().bg(t.surface).p(24).gap(8).text_size(14)
      .child(div().text_size(20).font_semibold().text_color(t.foreground).child(this.title))
      .child(line)
  }
}
