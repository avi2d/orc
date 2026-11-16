export interface TextPart {
  readonly text: string
  readonly opens: string | null
}

const prAddress = /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/g

export const textParts = (text: string): ReadonlyArray<TextPart> => {
  const parts: Array<TextPart> = []
  let from = 0
  for (const found of text.matchAll(prAddress)) {
    if (found.index > from) parts.push({ text: text.slice(from, found.index), opens: null })
    parts.push({ text: found[0], opens: found[0] })
    from = found.index + found[0].length
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), opens: null })
  return parts
}
