import { expect, test } from "bun:test"
import { type Node, appSettings, click, cx, node, nodes, press } from "./gpui-fakes"

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

const shows = (element: object | string, text: string): boolean =>
  typeof element === "string" ? element === text : nodes.get(element)?.kids.some((kid) => shows(kid, text)) === true

const argument = (view: Node, call: string): unknown => view.calls.find(({ name }) => name === call)?.args[0]

const hovered = (link: Node): Node => {
  const apply = argument(link, "hover")
  const style = node()
  if (typeof apply === "function") apply(style)
  const result = nodes.get(style)
  if (result === undefined) throw new Error("Missing hover style")
  return result
}

const paperLinks = { rest: "#00458f", hover: "#002f66" }

test("clicking a gallery link reports the exact destination without opening the browser or including punctuation", async () => {
  const { linkedText } = await import("../../../packages/herdr-app/src/links-view")
  const url = "https://example.invalid/garden/notes/pull/42"
  const receipts: Array<string> = []
  const drawn = linkedText("preview", `Read ${url}: the checks passed.`, (opened) => receipts.push(opened))
  click(linkWithText(drawn, url))
  expect(receipts).toEqual([url])
})

test("the Paper preview in a dark App draws Paper's link colours instead of the dark App's", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const url = "https://example.invalid/garden/orchard-runner-with-a-long-project-name/pull/42"
  const gallery = new DesignSystem()
  appSettings["theme"] = "Graphite"
  try {
    gallery.init({}, cx)
    press(gallery, "gallery-theme-paper")
    press(gallery, "choose-linked-text.wrapped")
    const link = linkWithText(gallery.render(), url)
    if (link === null) throw new Error("Missing wrapped sample link")
    expect({ rest: argument(link, "text_color"), hover: argument(hovered(link), "text_color") }).toEqual(paperLinks)
    press(gallery, "gallery-page-1")
    const shown = gallery.render()
    expect([shows(shown, paperLinks.rest), shows(shown, paperLinks.hover)]).toEqual([true, true])
  } finally {
    gallery.close(cx)
  }
})

test("thread links drawn for a Paper surface in a dark App use Paper's link colours instead of the dark App's", async () => {
  const { readOnlyThread, threadDecided, threadEntry } = await import("../../../packages/herdr-app/src/thread-view")
  const { linksOn, palette } = await import("../../../packages/herdr-app/src/palette")
  const url = "https://example.invalid/garden/notes/pull/42"
  const line = { who: "worker", kind: "note", text: `See ${url}.`, at: null, id: "garden-42.gallery.asked" } as const
  const card = { key: "note", line, what: "Note", ask: null, answers: [], delivered: false, notes: [line], reply: null, waitsOn: [] }
  const decided = { who: "user", kind: "answer", text: `Use ${url}.`, at: null, id: "garden-42.gallery.asked" } as const
  appSettings["theme"] = "Graphite"
  const t = palette()
  const links = linksOn("#ffffff")
  const drawn = [threadEntry(t, card, readOnlyThread, links), ...threadDecided(t, { task: "garden-42", entries: [decided] }, links)]
  const colours = drawn.map((element) => {
    const link = linkWithText(element, url)
    if (link === null) throw new Error("Missing thread link")
    return { rest: argument(link, "text_color"), hover: argument(hovered(link), "text_color") }
  })
  expect(colours).toEqual([paperLinks, paperLinks])
})
