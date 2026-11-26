import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AttentionItem, Decision } from "../../../packages/run/src/entities/attention/attention-item"
import { decodeStoredAttention } from "../../../packages/run/src/entities/attention/attention-migration"
import { Answer } from "../../../packages/run/src/entities/backlog/task-record-decision"

const decode = Schema.decodeUnknownSync(Decision)

const at = "2026-11-20T10:00:00Z"
const attention = { task: "example-1", text: "Keep the flag?", owner: "user", asked: at }
const answer = { words: "Keep the flag", at }

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

test("a closed attention item refuses missing attribution on either answer", () => {
  const parse = Schema.decodeUnknownSync(AttentionItem)
  const entry = { ...attention, kind: "review-question" }
  for (const state of [
    { kind: "closed", answer },
    { kind: "closed", answer: { ...answer, decider: "owner" }, overturned: answer }
  ]) {
    expect(() => parse({ ...entry, state })).toThrow()
  }
  for (const decider of ["owner", "agent"]) {
    const state = { kind: "closed", answer: { ...answer, decider }, overturned: { ...answer, decider } }
    expect(parse({ ...entry, state })).toMatchObject({ state })
  }
})

test("a decision-task answer refuses missing attribution instead of assuming who answered", () => {
  const parse = Schema.decodeUnknownSync(Answer)
  expect(() => parse(answer)).toThrow()
  for (const decider of ["owner", "agent"]) {
    expect(parse({ ...answer, decider })).toEqual({ ...answer, decider })
  }
})

test("legacy attention decisions migrate as agent actions without assigning the owner's later answer to the agent", async () => {
  for (const decision of decisions) {
    const item = await Effect.runPromise(decodeStoredAttention(JSON.stringify({
      ...attention,
      kind: "review-question",
      decision,
      state: { kind: "open" }
    })))
    expect(item.decision).toEqual({ ...decision, decider: "agent" })
  }
  const decision = { kind: "asked-back", at, question: "Which rule?" }
  for (const [words, decider] of [
    ["Before it answers, orc's decider asks you: Which rule?\nPut your reply in a new orc_ask question.", "agent"],
    ["Keep the flag and update its help", "owner"]
  ]) {
    const item = await Effect.runPromise(decodeStoredAttention(JSON.stringify({
      ...attention, kind: "review-question", decision, state: { kind: "closed", answer: { at, words } }
    })))
    expect(item.state).toMatchObject({ answer: { decider } })
  }
})

test("legacy merge closures mark inferred attribution without changing an explicit owner answer", async () => {
  for (const words of ["merged", "closed without merging"]) {
    const entry = { ...attention, kind: "pr-ready" }
    const read = (answer: unknown) => Effect.runPromise(decodeStoredAttention(JSON.stringify({
      ...entry, state: { kind: "closed", answer }
    })))
    expect((await read({ words, at })).state).toMatchObject({ answer: { decider: "agent", inferred: true } })
    expect((await read({ words, at, decider: "owner" })).state).toEqual({ kind: "closed", answer: { words, at, decider: "owner" } })
  }
})
