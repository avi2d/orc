import { expect, test } from "bun:test"
import { overLimit, parts, type MapPart } from "../../docs/map/orc-map"

const part = (id: string, short: string): MapPart => ({ id, title: id, short })

test("rejects a map node whose short text runs over the limit", () => {
  expect(overLimit(parts)).toEqual([])
})

test("rejects a limit other than 40 characters", () => {
  expect(overLimit([part("at-limit", "x".repeat(40)), part("past-limit", "x".repeat(41))])).toEqual(["past-limit has 41 characters of short text, over 40"])
})
