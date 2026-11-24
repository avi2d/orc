import type { AttentionItem } from "../../entities/attention/index"

export interface RuleSource {
  readonly source: string
  readonly text: string
}

export interface Quoted {
  readonly source: string
  readonly quote: string
}

type Basis = { readonly kind: "rule"; readonly quote: string; readonly source: string; readonly reason: string } | { readonly kind: "duplicate"; readonly of: string }

export type Verdict =
  | { readonly kind: "answered"; readonly words: string; readonly basis: Basis }
  | { readonly kind: "asked-back"; readonly question: string }
  | { readonly kind: "escalated"; readonly reason: string; readonly recommendation?: string }

export const spaced = (text: string): string => text.replace(/\s+/g, " ").trim()

const unquoted = (quote: string): string => spaced(quote).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")

const stripMarker = (line: string): string => spaced(line).replace(/^(?:[-*+>]\s+|\d+[.)]\s+)/, "")

const pushOnce = (out: Array<string>, value: string): void => {
  if (value !== "" && !out.includes(value)) {
    out.push(value)
  }
}

const sentencesOf = (text: string): ReadonlyArray<string> =>
  text.split(/(?<=[.!?])\s+/).map(unquoted).filter((sentence) => sentence !== "")

const collectSentences = (out: Array<string>, text: string): void => {
  for (const sentence of sentencesOf(text)) {
    pushOnce(out, sentence)
  }
}

const collectLine = (out: Array<string>, line: string): void => {
  pushOnce(out, unquoted(line))
  collectSentences(out, line)
}

const collectParagraph = (out: Array<string>, paragraph: string): void => {
  const lines = paragraph.split("\n").map(stripMarker).filter((line) => line !== "")
  for (const line of lines) {
    collectLine(out, line)
  }
  if (lines.length === 0) {
    return
  }
  const joined = spaced(lines.filter((line) => !/^#{1,6}\s/.test(line)).join(" "))
  pushOnce(out, unquoted(joined))
  collectSentences(out, joined)
}

const sentencesAndLinesOf = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const paragraph of text.split(/\n\s*\n/)) {
    collectParagraph(out, paragraph)
  }
  return out
}

const opensClause = (before: string): boolean => before === "" || /[.!?:;]["'”’)]*\s$/.test(before)

const closesClause = (wanted: string, after: string): boolean =>
  after === "" || (/[.!?:;]["'”’)]*$/.test(wanted) && /^\s/.test(after)) || /^["'”’)]*[.!?:;](?:["'”’)]*\s|["'”’)]*$)/.test(after)

// A quote holding only a word or two of a sentence must not pass as a rule, so its ends have to sit on clause marks.
const holdsClause = (segment: string, wanted: string): boolean => {
  for (let at = segment.indexOf(wanted); at !== -1; at = segment.indexOf(wanted, at + 1)) {
    if (opensClause(segment.slice(0, at)) && closesClause(wanted, segment.slice(at + wanted.length))) {
      return true
    }
  }
  return false
}

const normalizedQuote = (quote: string): string => unquoted(stripMarker(unquoted(quote)))

const comparisonWords = (text: string): string =>
  spaced(
    text
      .replace(/["'“”‘’`]/g, "")
      .replace(/[.,;:?]+(?=\s|$)|\s[-–—]+(?=\s)/g, " ")
  )

export const quotedSource = (quote: string, sources: ReadonlyArray<RuleSource>): Quoted | undefined => {
  const wanted = normalizedQuote(quote)
  const words = comparisonWords(wanted)
  if (words === "") {
    return undefined
  }
  for (const source of sources) {
    for (const segment of sentencesAndLinesOf(source.text)) {
      if (holdsClause(segment, wanted)) {
        return { source: source.source, quote: wanted }
      }
      if (comparisonWords(segment) === words) {
        return { source: source.source, quote: segment }
      }
    }
  }
  return undefined
}

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
