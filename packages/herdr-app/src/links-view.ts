import { type Element, div } from "gpui-kit"
import { h_flex } from "gpui-base"
import { textParts } from "./links"

export const linkedText = (id: string, text: string): Element => {
  const parts = textParts(text)
  if (parts.every((part) => part.opens === null)) return div().child(text)
  return h_flex().flex_wrap().min_w_0().children(parts.map((part, index) => {
    const opens = part.opens
    return opens === null
      ? div().child(part.text)
      : div().id(`${id}-link-${index}`).cursor_pointer().hover((style) => style.underline())
        .on_click((_event, cx) => cx.open_url(opens)).child(part.text)
  }))
}
