import { expect, test } from "bun:test"
import { findGalleryStories, visibleGalleryRows } from "../../../packages/herdr-app/src/gallery-selection"

test("search finds a multiword example regardless of case instead of including other button sizes or looks", () => {
  expect(findGalleryStories("  GHOST 32  ").map((story) => story.id)).toEqual([
    "button.32.ghost.enabled", "button.32.ghost.disabled"
  ])
  expect(findGalleryStories("unmatched words")).toEqual([])
})

test("folding one group keeps its header and other groups' runs instead of hiding the rest of the list", () => {
  const story = findGalleryStories("rows.grouped")[0]
  if (story?.component !== "uniformRows") throw new Error("Grouped list fixture is missing")
  const shown = visibleGalleryRows(story, new Set(["attention"]))
  expect(shown.slice(0, 3).map((row) => row.key)).toEqual(["attention", "active", "run-1"])
  expect(shown.map((row) => row.key)).not.toContain("garden")
  expect(shown.at(-1)?.key).toBe("run-24")
})
