import { expect, test } from "bun:test"
import { clipTitle } from "../../../packages/herdr-app/src/board"

test("a three-line title shows two lines instead of all three", () => {
  expect(clipTitle("first\nsecond\nthird")).toBe("first\nsecond")
})

test("a two-line title keeps both lines instead of dropping one", () => {
  expect(clipTitle("first\nsecond")).toBe("first\nsecond")
})
