import { describe, expect, test } from "bun:test"
import { parseRefuseMarkers } from "../../src/run"

describe("parseRefuseMarkers", () => {
  test("no value names no marker", () => {
    expect(parseRefuseMarkers(undefined)).toEqual([])
  })

  test("a blank value names no marker", () => {
    expect(parseRefuseMarkers("")).toEqual([])
    expect(parseRefuseMarkers("  ,  ")).toEqual([])
  })

  test("names split on commas with the padding trimmed", () => {
    expect(parseRefuseMarkers(".slot-owner, .other-owner ")).toEqual([".slot-owner", ".other-owner"])
  })
})
