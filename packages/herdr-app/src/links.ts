export interface TextPart {
  readonly text: string
  readonly opens: string | null
}

const webAddress = /(https?:\/\/)(?=[^\s<>"`“”‘’/?#])[^\s<>"`“”‘’]+/gi
const prosePunctuation = /[.,:;!?']+$/
const openingFor = new Map([[")", "("], ["]", "["], ["}", "{"]])

const trimProse = (candidate: string): string => {
  let url = candidate.replace(prosePunctuation, "")
  let last = url.at(-1)
  while (last !== undefined) {
    const opening = openingFor.get(last)
    if (opening === undefined || url.split(last).length <= url.split(opening).length) break
    url = url.slice(0, -1).replace(prosePunctuation, "")
    last = url.at(-1)
  }
  return url
}

export const textParts = (text: string): ReadonlyArray<TextPart> => {
  const parts: Array<TextPart> = []
  let from = 0
  for (const found of text.matchAll(webAddress)) {
    const url = trimProse(found[0])
    if (url === found[1]) continue
    if (found.index > from) parts.push({ text: text.slice(from, found.index), opens: null })
    parts.push({ text: url, opens: url })
    from = found.index + url.length
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), opens: null })
  return parts
}

export const hasLinks = (text: string): boolean => textParts(text).some((part) => part.opens !== null)

export const lineWords = (line: string): ReadonlyArray<ReadonlyArray<TextPart>> =>
  (line.match(/\S+\s*|\s+/g) ?? [""]).map(textParts)
