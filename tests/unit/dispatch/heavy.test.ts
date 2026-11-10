import { describe, expect, test } from "bun:test"
import { heavyBinDir, heavyGroup, resolveHeavy, withHeavyPath } from "../../../packages/run/src/dispatch/heavy"

describe("heavy queue paths", () => {
  test("the group is heavy", () => {
    expect(heavyGroup).toBe("heavy")
  })

  test("the stand-in folder lives under the home", () => {
    expect(heavyBinDir("/tmp/home")).toBe("/tmp/home/heavy/bin")
  })

  test("the stand-in folder prefixes the inherited path", () => {
    expect(withHeavyPath("/home", "/usr/bin:/bin")).toBe("/home/heavy/bin:/usr/bin:/bin")
  })

  test("missing heavy config resolves to the default group with no commands", () => {
    expect(resolveHeavy(undefined)).toEqual({ group: "heavy", commands: [], limit: "auto", through: null })
  })
})
