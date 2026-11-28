import { expect, test } from "bun:test"
import { galleryStories } from "../../../packages/herdr-app/src/gallery-stories"
import { resolvePalette } from "../../../packages/herdr-app/src/palette-values"
import { click, cx, find, typeIn } from "./gpui-fakes"

test("sample submission cannot send busy fields, read-only threads, or unrelated examples", async () => {
  const { GalleryExample } = await import("../../../packages/herdr-app/src/gallery-example")
  const { linkPalette } = await import("../../../packages/herdr-app/src/palette")
  const fixture = new GalleryExample()
  const t = resolvePalette({})
  const sendable = new Set(["field-with-button.empty", "field-with-button.ready", "thread.question", "thread.reply-failed"])
  for (const story of galleryStories) {
    fixture.reset(story, cx)
    typeIn(fixture.input, "  Compare the colours.  ")
    fixture.submit(story, cx)
    const expected = sendable.has(story.id) ? "Sample answer: Compare the colours." : null
    expect({ id: story.id, receipt: fixture.receipt }).toEqual({ id: story.id, receipt: expected })
    if (story.component === "fieldWithButton") {
      fixture.reset(story, cx)
      typeIn(fixture.input, "  Compare the colours.  ")
      const send = find(fixture.render(t, linkPalette("theme"), story), story.id)
      expect(send).not.toBeNull()
      click(send)
      expect({ id: story.id, receipt: fixture.receipt }).toEqual({ id: story.id, receipt: expected })
    }
  }
  fixture.input.release()
})
