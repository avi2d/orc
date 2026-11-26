import { describe, expect, test } from "bun:test"
import { ownerPollMillis } from "../../../packages/run/src/entities/heavy-queue/heavy-standin-exec"

describe("the queued call waiter's owner check", () => {
  test("checks every five seconds when no interval is set instead of a shortened test interval", () => {
    expect(ownerPollMillis({})).toBe(5000)
  })

  test("checks every five seconds for an interval that is no positive number instead of polling without a pause", () => {
    expect(["0", "-50", "abc", ""].map((value) => ownerPollMillis({ ORC_HEAVY_OWNER_POLL_MILLIS: value }))).toEqual([5000, 5000, 5000, 5000])
  })

  test("checks at a set interval instead of the five second default", () => {
    expect(ownerPollMillis({ ORC_HEAVY_OWNER_POLL_MILLIS: "50" })).toBe(50)
  })
})
