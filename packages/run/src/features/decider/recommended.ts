import { comparisonWords, normalizedQuote, type Quoted, quotedSource, type RuleSource, type Verdict } from "./quoted-source"

const recommendedLine = /^[\t ]*Recommended:[\t ]*(\S.*)$/m

const recommendedOption = (question: string): string | undefined => recommendedLine.exec(question)?.[1]?.trim()

const recommendedRule = "When a question names a recommended option and the question is not on the never list, answer with that option even when it picks between product choices the intent leaves open or you are not sure."

// The policy lifts only these two escalation bullets for a question that names a recommended option, so every other reason still escalates.
const liftedBullets: ReadonlyArray<string> = ["It picks between product choices that the intent leaves open.", "You are not sure."]

const restsOnLiftedBullet = (rule: unknown): rule is string =>
  typeof rule === "string" && liftedBullets.some((bullet) => comparisonWords(normalizedQuote(rule)) === comparisonWords(bullet))

export const recommendedAnswer = (reply: { readonly rule?: unknown }, sources: ReadonlyArray<RuleSource>, question: string): Verdict | undefined => {
  const option = recommendedOption(question)
  if (option === undefined || !restsOnLiftedBullet(reply.rule)) {
    return undefined
  }
  const found = quotedSource(recommendedRule, sources)
  return found === undefined
    ? undefined
    : { kind: "answered", words: option, basis: { kind: "rule", quote: found.quote, source: found.source, reason: "the question names " + JSON.stringify(option) + " on its Recommended: line, and the decider escalated only on the policy bullet " + JSON.stringify(reply.rule) } }
}

export const quotesRecommendedRule = (found: Quoted): boolean => comparisonWords(normalizedQuote(found.quote)) === comparisonWords(recommendedRule)

// The decider may pick the other remedy on that rule, so orc answers on it only with the question's own Recommended: option.
export const answerOnRecommendedRule = (found: Quoted, reply: { readonly answer: string; readonly reason: string }, question: string): Verdict => {
  const option = recommendedOption(question)
  return option === undefined
    ? { kind: "escalated", reason: "the decider answered " + JSON.stringify(reply.answer) + " on the rule for a recommended option, and the question has no Recommended: line" }
    : { kind: "answered", words: option, basis: { kind: "rule", quote: found.quote, source: found.source, reason: reply.reason } }
}
