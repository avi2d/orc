import { expect, test } from "bun:test"
import { type Node, click, nodes } from "./gpui-fakes"

const linkWithText = (element: object | string, text: string): Node | null => {
  if (typeof element === "string") return null
  const drawn = nodes.get(element)
  if (drawn === undefined) return null
  if (drawn.kids.includes(text)) return drawn
  for (const child of drawn.kids) {
    const found = linkWithText(child, text)
    if (found !== null) return found
  }
  return null
}

test("clicking a gallery link reports the exact destination without opening the browser or including punctuation", async () => {
  const { linkedText } = await import("../../../packages/herdr-app/src/links-view")
  const url = "https://example.invalid/garden/notes/pull/42"
  const receipts: Array<string> = []
  const drawn = linkedText("preview", `Read ${url}: the checks passed.`, (opened) => receipts.push(opened))
  click(linkWithText(drawn, url))
  expect(receipts).toEqual([url])
})
