import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { firstPollFromEnv, pollWaitSeconds } from "../../packages/run/src/features/merging-a-pr/merge-poll"

describe("firstPollFromEnv", () => {
  test("an unset or blank value waits 1 second first instead of not waiting", () => {
    expect(Effect.runSync(firstPollFromEnv(undefined))).toBe(1)
    expect(Effect.runSync(firstPollFromEnv("  "))).toBe(1)
  })

  test("a fraction of a second is taken as given instead of rounded to whole seconds", () => {
    expect(Effect.runSync(firstPollFromEnv("0.05"))).toBe(0.05)
    expect(Effect.runSync(firstPollFromEnv(" 15 "))).toBe(15)
  })

  test("zero, a negative, a unit, an exponent and a wait above 15 seconds are refused instead of read as a number", () => {
    for (const value of ["0", "0.0", "-1", "2s", "1e1", "16", "abc"]) {
      expect(Effect.runSync(Effect.flip(firstPollFromEnv(value))).detail).toContain("ORC_MERGE_POLL_SECONDS is " + value)
    }
  })
})

describe("pollWaitSeconds", () => {
  test("the waits double from the first one up to 15 seconds instead of staying flat or growing past 15", () => {
    expect([0, 1, 2, 3, 4, 5].map((poll) => pollWaitSeconds(1, poll))).toEqual([1, 2, 4, 8, 15, 15])
    expect([0, 1, 2].map((poll) => pollWaitSeconds(0.05, poll))).toEqual([0.05, 0.1, 0.2])
  })
})
