import { Effect } from "effect"
import { checkDocPages } from "./doc-pages"

const limit = 300
const exempt = new Set(["index.md", "map/index.md"])
const headingPattern = /^#{1,6}\s+\S.*$/

const wordsOf = (value: string): number => {
  const tokens = value.trim().split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token))
  return value.trim() === "" ? 0 : tokens.length
}
const overLimit = (failures: Array<string>, name: string, heading: string, body: string): void => {
  const count = wordsOf(body)
  if (count > limit) failures.push(name + ": " + count.toString() + " words after \"" + heading + "\" (limit " + limit.toString() + ")")
}
const failuresOf = (name: string, source: string): Array<string> => {
  const withoutFrontmatter = source.replace(/^---\n[\s\S]*?\n---\n/, "")
  const prose = withoutFrontmatter.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
  const lines = prose.split("\n")
  if (!lines.some((line) => headingPattern.test(line))) {
    const total = wordsOf(prose)
    return total > limit ? [name + ": " + total.toString() + " words with no heading (limit " + limit.toString() + ")"] : []
  }
  const failures: Array<string> = []
  let current: string | undefined
  let body: Array<string> = []
  for (const line of lines) {
    if (headingPattern.test(line)) {
      if (current !== undefined) overLimit(failures, name, current, body.join("\n"))
      current = line
      body = []
    } else if (current !== undefined) {
      body.push(line)
    }
  }
  if (current !== undefined) overLimit(failures, name, current, body.join("\n"))
  return failures
}
void Effect.runPromise(
  checkDocPages({
    skipsDirectory: (name) => name === "adr" || name.startsWith("."),
    checksPage: (page) => !exempt.has(page),
    failuresOf,
    passed: (pages) => "Checked section lengths in " + pages.toString() + " documentation pages"
  })
)
