import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { parseRefuseMarkers } from "../../packages/run/src/checkout"
import { idleTimeoutFromEnv, toolchainFromEnv } from "../../packages/run/src/run"

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

const toolchainFor = (value: string | undefined) => Effect.runSync(Effect.result(toolchainFromEnv(value, "/Users/test")))

const refusal = (value: string): string => {
  const result = toolchainFor(value)
  return Result.isFailure(result) ? result.failure.message : "accepted"
}

describe("toolchainFromEnv", () => {
  test("a named folder grants bun's own installer layout, which the default layout refuses", () => {
    const bun = ["/Users/test/.bun/bin/bun", "/Users/test/.bun/bin/bun"] as const
    const unset = toolchainFor(undefined)
    const named = toolchainFor("/Users/test/.bun/")
    expect(Result.isSuccess(unset) && unset.success.runtimeOf(...bun)).toBeNull()
    expect(Result.isSuccess(named) && named.success.runtimeOf(...bun)).toEqual({ binDir: "/Users/test/.bun/bin", installDir: "/Users/test/.bun" })
  })

  test("a named folder grants nothing for a link inside it whose target lies outside it", () => {
    const named = toolchainFor("/Users/test/.bun")
    expect(Result.isSuccess(named) && named.success.runtimeOf("/Users/test/.bun/bin/node", "/Users/test/node/bin/node")).toBeNull()
  })

  test("a folder holding HOME is refused, and so is a relative one", () => {
    expect(refusal("/")).toContain("holds HOME")
    expect(refusal("/Users")).toContain("holds HOME")
    expect(refusal("/Users/test")).toContain("holds HOME")
    expect(refusal("/opt/tools:.bun")).toContain("not an absolute path")
  })
})

const idleTimeoutFor = (value: string | undefined) => Effect.runSync(Effect.result(idleTimeoutFromEnv(value)))

describe("idleTimeoutFromEnv", () => {
  test("no value waits 45 minutes, not the 600 seconds that killed quiet lint runs", () => {
    expect(idleTimeoutFor(undefined)).toEqual(Result.succeed(2700))
    expect(idleTimeoutFor("  ")).toEqual(Result.succeed(2700))
  })

  test("a whole number of seconds is taken as given", () => {
    expect(idleTimeoutFor(" 3600 ")).toEqual(Result.succeed(3600))
  })

  test("zero, a fraction, a unit and a negative are refused instead of read as a number", () => {
    for (const value of ["0", "1.5", "45m", "-60", "0600"]) {
      const result = idleTimeoutFor(value)
      expect(Result.isFailure(result) && result.failure.message).toContain("ORC_IDLE_TIMEOUT_SECONDS is " + value)
    }
  })
})
