import { describe, expect, test } from "bun:test"
import { alertFires } from "../../../packages/run/src/entities/events/index"

describe("the bypass alert", () => {
  test("a bypass line reads as a fire naming the reason", () => {
    const line = JSON.stringify({ rule: "heavy-bypass", at: "2026-01-01T00:00:00Z", reason: "hotfix", command: "bun x" })
    const fires = alertFires("alerts.jsonl", line + "\n")
    expect(fires.length).toBe(1)
    expect(fires[0]?.text).toBe("alert: bun x bypassed the heavy queue: hotfix")
  })
})
