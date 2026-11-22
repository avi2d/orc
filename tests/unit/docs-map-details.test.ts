import { expect, test } from "bun:test"
import { type DetailsEvent, type DetailsState, detailsAfter, returnsFocus } from "../../docs/map/details"

const run = (events: readonly DetailsEvent[]): DetailsState => events.reduce(detailsAfter, "closed")

test("rejects details that fail to open on a tap or on Enter or Space", () => {
  expect(run(["press"])).toBe("pinned")
})

test("rejects details that fail to open when a mouse hovers the button", () => {
  expect(run(["enter"])).toBe("hover")
})

test("rejects hover details that stay open after the mouse leaves", () => {
  expect(run(["enter", "leave"])).toBe("closed")
})

test("rejects tapped details that close when the mouse leaves", () => {
  expect(run(["press", "leave"])).toBe("pinned")
  expect(run(["enter", "press", "leave"])).toBe("pinned")
})

test("rejects details that stay open on Escape, an outside press or a second press", () => {
  for (const close of ["escape", "outside", "press"] as const) expect(run(["press", close])).toBe("closed")
  expect(run(["enter", "escape"])).toBe("closed")
})

test("rejects a close by Escape or an outside press that leaves focus off the button", () => {
  expect(returnsFocus("pinned", "escape")).toBe(true)
  expect(returnsFocus("hover", "outside")).toBe(true)
  expect(returnsFocus("closed", "outside")).toBe(false)
  expect(returnsFocus("hover", "leave")).toBe(false)
})
