import { Option, Schema } from "effect"
import { objectIn, section } from "./prompt-text"
import type { Quoted, Verdict } from "./quoted-source"

const SupportReply = Schema.Union([
  Schema.Struct({ verdict: Schema.Literal("supports") }),
  Schema.Struct({ verdict: Schema.Literal("does-not-support"), reason: Schema.String.check(Schema.isNonEmpty()) })
])

const decodeSupport = Schema.decodeUnknownOption(Schema.fromJsonString(SupportReply))

interface RuleAnswer {
  readonly answer: string
  readonly reason: string
}

// The decider's reason stays out, so the check judges the rule and the answer on their own words.
export const supportPrompt = (intent: string, found: Quoted, answer: string, question: string): string =>
  [
    section("The intent of the task", intent),
    section("The rule the decider quoted, from " + found.source, found.quote),
    section("The question", question),
    section("The answer the decider gives on that rule", answer)
  ].join("\n\n")

export const supportVerdict = (text: string, found: Quoted, reply: RuleAnswer): Verdict => {
  const answer = reply.answer.trim()
  const read = decodeSupport(objectIn(text))
  if (Option.isNone(read)) {
    return { kind: "escalated", reason: "the check that the rule supports the decider's answer " + JSON.stringify(answer) + " gave no verdict orc reads: " + text.trim().slice(0, 200) }
  }
  return read.value.verdict === "supports"
    ? { kind: "answered", words: answer, basis: { kind: "rule", quote: found.quote, source: found.source, reason: reply.reason } }
    : { kind: "escalated", reason: "the decider answered " + JSON.stringify(answer) + " on the rule " + JSON.stringify(found.quote) + ", and the check found the rule does not support it: " + read.value.reason }
}
