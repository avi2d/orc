import { type Element, div } from "gpui-kit"
import { Link, h_flex, v_flex } from "gpui-base"
import { hasLinks, lineWords } from "./links"
import { linkPalette } from "./palette"

type LinkPalette = ReturnType<typeof linkPalette>

let pointerFocusedId: string | null = null

const webLink = (t: LinkPalette, id: string, url: string): Element => {
  const link = Link.new(id).href(url).tab_stop(true).cursor_pointer().min_w_0().truncate()
    .text_color(t.link).underline().tooltip(url)
    .hover((style) => style.text_color(t.linkHover))
    .child(url)
  if (pointerFocusedId === id) {
    // Tab moves focus on key-down, so only its release reaches the new link.
    return link.on_key_up((_event, cx) => {
      if (pointerFocusedId !== id) return
      pointerFocusedId = null
      cx.notify()
    })
  }
  return link.focus((style) => style.bg(t.link).text_color(t.linkFocusForeground))
    .on_mouse_down("left", (_event, cx) => {
      pointerFocusedId = id
      cx.notify()
    })
}

// A flex item per clause would wrap the whole clause instead of filling the line beside a link.
const linkedLine = (t: LinkPalette, id: string, line: string): Element => {
  const words = lineWords(line).map((word, wordIndex) => {
    const parts = word.map((part, index) => part.opens === null
      ? div().child(part.text === "" ? " " : part.text)
      : webLink(t, `${id}-${wordIndex}-${index}`, part.opens))
    return h_flex().min_w_0().max_w_full().children(parts)
  })
  return h_flex().flex_wrap().items_start().min_w_0().children(words)
}

export const linkedText = (id: string, text: string): Element => {
  if (!hasLinks(text)) return div().child(text)
  const t = linkPalette()
  return v_flex().min_w_0().children(text.split("\n").map((line, index) => linkedLine(t, `${id}-link-${index}`, line)))
}
