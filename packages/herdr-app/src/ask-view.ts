import { type Context, type Element, div } from "gpui-kit"
import { Avatar, AvatarFallback, AvatarImage, v_flex } from "gpui-base"
import { exec, nextCommand } from "herdr"
import { exitReason } from "./orc-read"
import type { palette } from "./palette"
import { type AskOption, optionShape } from "./thread"

type Palette = ReturnType<typeof palette>

export type Sent = { readonly kind: "sending" } | { readonly kind: "failed"; readonly reason: string }

export interface OrcSender {
  readonly sent: Map<string, Sent>
  reload(cx: Context): void
}

export const sendOrc = (host: OrcSender, cx: Context, key: string, argv: ReadonlyArray<string>, done: () => void, current: () => boolean = () => true): void => {
  host.sent.set(key, { kind: "sending" })
  cx.spawn((task) => exec("orc", [...argv]).then(
    (result) => {
      if (current() && result.code === 0) {
        host.sent.delete(key)
        done()
      } else if (current()) {
        host.sent.set(key, { kind: "failed", reason: exitReason(`orc ${argv.join(" ")}`, result) })
      }
      host.reload(task)
      task.notify()
    },
    () => {
      if (!current()) return
      host.sent.set(key, { kind: "failed", reason: "Could not start orc. Check that it is on PATH." })
      task.notify()
    }
  ))
  cx.notify()
}

export const listenFor = (command: string, act: () => void): Promise<void> =>
  nextCommand().then((said) => {
    if (said === command) act()
    return listenFor(command, act)
  })

export const section = (t: Palette, label: string, content: Element): Element =>
  v_flex().gap(2).child(div().text_size(12).text_color(t.muted).child(label)).child(content)

export const optionView = (t: Palette, id: string, option: AskOption): Element => {
  const label = `${option.letter}) ${option.text}`
  const shape = optionShape(option)
  return shape.kind === "tile"
    ? v_flex().id(id).w(180).rounded(6).border(1).border_color(t.border).bg(t.background).overflow_hidden()
      .child(Avatar.new().w(180).h(112).overflow_hidden()
        .image(new AvatarImage(shape.picture).size_full())
        .fallback(AvatarFallback.new().size_full().items_center().justify_center().p(6).text_size(11).text_color(t.muted).child(shape.picture)))
      .child(div().p(6).child(label))
    : div().id(id).px(12).py(4).rounded(6).border(1).border_color(t.border).bg(t.background).child(label)
}

export const actionButton = (t: Palette, id: string, label: string, busy: boolean, press: (cx: Context) => void): Element => {
  const button = div().id(id).flex_shrink_0().px(12).py(4).rounded(6).border(1).border_color(t.border).bg(t.raised)
  return busy
    ? button.text_color(t.dim).child(label)
    : button.cursor_pointer().hover((style) => style.bg(t.hover)).on_click((_event, cx) => press(cx)).child(label)
}

export const failureLine = (t: Palette, sent: Sent | undefined): ReadonlyArray<Element> =>
  sent?.kind === "failed" ? [div().text_color(t.blocked).child(sent.reason)] : []
