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

export const normalizedQuote = (quote: string): string => unquoted(stripMarker(unquoted(quote)))

export const comparisonWords = (text: string): string =>
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
