import type { AttentionItem } from "../../entities/attention/index"
import { comparisonWords, normalizedQuote, type Quoted, quotedSource, type RuleSource, type Verdict } from "./quoted-source"

const recommendedLine = /^[\t ]*Recommended:[\t ]*(\S.*)$/m

const recommendedOption = (question: string): string | undefined => recommendedLine.exec(question)?.[1]?.trim()

const recommendedRule = "When a review question names a recommended option and the question is not on the never list, answer with that option even when it picks between product choices the intent leaves open or you are not sure."

// The policy lifts only these two escalation bullets for a question that names a recommended option, so every other reason still escalates.
const liftedBullets: ReadonlyArray<string> = ["It picks between product choices that the intent leaves open.", "You are not sure."]

const restsOnLiftedBullet = (rule: unknown): rule is string =>
  typeof rule === "string" && liftedBullets.some((bullet) => comparisonWords(normalizedQuote(rule)) === comparisonWords(bullet))

// A worker question keeps the decider's escalation, because its Recommended: line is the worker's own preference.
export const recommendedAnswer = (reply: { readonly rule?: unknown }, sources: ReadonlyArray<RuleSource>, kind: AttentionItem["kind"], question: string): Verdict | undefined => {
  const option = recommendedOption(question)
  if (kind !== "review-question" || option === undefined || !restsOnLiftedBullet(reply.rule)) {
    return undefined
  }
  const found = quotedSource(recommendedRule, sources)
  return found === undefined
    ? undefined
    : { kind: "answered", words: option, basis: { kind: "rule", quote: found.quote, source: found.source, reason: "the question names " + JSON.stringify(option) + " on its Recommended: line, and the decider escalated only on the policy bullet " + JSON.stringify(reply.rule) } }
}

const quotesRecommendedRule = (found: Quoted): boolean => comparisonWords(normalizedQuote(found.quote)) === comparisonWords(recommendedRule)

// The decider may cite the review-question rule on a worker question or pick the other remedy, so orc answers on that rule only with the question's own Recommended: option.
export const answerOnRule = (found: Quoted, reply: { readonly answer: string; readonly reason: string }, kind: AttentionItem["kind"], question: string): Verdict => {
  if (!quotesRecommendedRule(found)) {
    return { kind: "answered", words: reply.answer.trim(), basis: { kind: "rule", quote: found.quote, source: found.source, reason: reply.reason } }
  }
  if (kind !== "review-question") {
    return { kind: "escalated", reason: "the decider answered " + JSON.stringify(reply.answer) + " on the rule for review questions, and this is a worker question" }
  }
  const option = recommendedOption(question)
  return option === undefined
    ? { kind: "escalated", reason: "the decider answered " + JSON.stringify(reply.answer) + " on the rule for a recommended option, and the question has no Recommended: line" }
    : { kind: "answered", words: option, basis: { kind: "rule", quote: found.quote, source: found.source, reason: reply.reason } }
}
