import { expect, test } from "bun:test"
import { cardTitle } from "../../../packages/herdr-app/src/board"

test("a title wrapping to three lines shows two instead of all three", () => {
  expect(cardTitle("0123456789".repeat(7))).toEqual(["012345678901234567890123456789", "012345678901234567890123456789"])
})

test("a short title stays whole instead of being split", () => {
  expect(cardTitle("Fix the login page")).toEqual(["Fix the login page"])
})
