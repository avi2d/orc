import { type Element, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { textParts } from "./links"

export const linkedText = (id: string, text: string): Element => {
  const parts = textParts(text)
  if (parts.every((part) => part.opens === null)) return div().child(text)
  return v_flex().min_w_0().children(text.split("\n").map((line, lineIndex) =>
    h_flex().flex_wrap().items_start().min_w_0().children(textParts(line).map((part, index) => {
      const opens = part.opens
      if (opens === null) return div().child(part.text === "" ? " " : part.text)
      return div().id(id + "-link-" + lineIndex + "-" + index).cursor_pointer().hover((style) => style.underline())
        .on_click((_event, cx) => cx.open_url(opens)).child(part.text)
    }))))
}
