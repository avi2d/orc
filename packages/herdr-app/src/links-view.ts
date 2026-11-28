import { type Context, type Element, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { lineWords, textParts } from "./links"

type OpenLink = (url: string, cx: Context) => void

const openUrl: OpenLink = (url, cx) => { cx.open_url(url) }

// One flex item per word: an item holding a whole clause moves below the link as one block instead of wrapping beside it.
export const linkedText = (id: string, text: string, open: OpenLink = openUrl): Element => {
  const parts = textParts(text)
  if (parts.every((part) => part.opens === null)) return div().child(text)
  return v_flex().min_w_0().children(text.split("\n").map((line, lineIndex) =>
    h_flex().flex_wrap().items_start().min_w_0().children(lineWords(line).map((word, wordIndex) =>
      h_flex().children(word.map((part, index) => {
        const opens = part.opens
        if (opens === null) return div().child(part.text === "" ? " " : part.text)
        return div().id(id + "-link-" + lineIndex + "-" + wordIndex + "-" + index).cursor_pointer().hover((style) => style.underline())
          .on_click((_event, cx) => open(opens, cx)).child(part.text)
      }))))))
}
