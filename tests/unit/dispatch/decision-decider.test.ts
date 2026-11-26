import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Decision } from "../../../packages/run/src/entities/attention/attention-item"

const decode = Schema.decodeUnknownSync(Decision)

const decisions = [
  { kind: "answered", reason: "The rule applies", at: "2026-11-20T10:00:00Z" },
  { kind: "escalated", reason: "The rule does not apply", at: "2026-11-20T10:00:00Z" },
  { kind: "asked-back", question: "Which rule?", at: "2026-11-20T10:00:00Z" },
  { kind: "duplicate", of: "question-1", at: "2026-11-20T10:00:00Z" }
]

describe("attention decision attribution", () => {
  for (const decision of decisions) {
    test(decision.kind + " refuses a missing decider instead of guessing", () => {
      expect(() => decode(decision)).toThrow()
    })

    test(decision.kind + " preserves both owner and agent attribution", () => {
      for (const decider of ["owner", "agent"]) {
        expect(decode({ ...decision, decider })).toMatchObject({ decider })
      }
    })
  }
})
