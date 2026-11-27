import { Effect } from "effect"
import { checkDocPages } from "./doc-pages"
import tools from "./outside-tools.json"

export interface OutsideTool {
  readonly name: string
  readonly url: string
}

const fencePattern = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm
const targetPatterns = [/\]\(\s*<?([^)\s>]+)/g, /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm, /<(https?:\/\/[^>\s]+)>/g, /href="([^"]+)"/g]
const proseCuts = [/`+[^`\n]*`+/g, /!?\[[^\]]*\]\([^)]*\)/g, /!?\[[^\]]*\]\[[^\]]*\]/g, /^\s*\[[^\]]+\]:.*$/gm, /<[^>\n]*>/g, /https?:\/\/\S+/g]

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const bare = (url: string): string => url.replace(/[#?].*$/, "").replace(/\/+$/, "")
const pageOf = (source: string): string => source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(fencePattern, "")
const targetsOf = (page: string): Set<string> =>
  new Set(targetPatterns.flatMap((pattern) => [...page.matchAll(pattern)].map((match) => bare(match[1]))))
const proseOf = (page: string): string => proseCuts.reduce((text, cut) => text.replace(cut, " "), page)
const mention = (name: string): RegExp =>
  new RegExp("(?<![\\p{L}\\p{N}_./-])" + escaped(name) + "(?![\\p{L}\\p{N}_-])", "giu")
const names = (prose: string, tool: OutsideTool, registry: ReadonlyArray<OutsideTool>): boolean =>
  mention(tool.name).test(
    registry
      .filter((other) => other.name.length > tool.name.length && mention(tool.name).test(other.name))
      .reduce((text, other) => text.replace(mention(other.name), " "), prose)
  )

export const unlinkedTools = (source: string, registry: ReadonlyArray<OutsideTool>): Array<OutsideTool> => {
  const page = pageOf(source)
  const targets = targetsOf(page)
  const prose = proseOf(page)
  return registry.filter((tool) => names(prose, tool, registry) && !targets.has(bare(tool.url)))
}

const program = checkDocPages({
  skipsDirectory: (name) => name.startsWith("."),
  checksPage: () => true,
  failuresOf: (page, source) =>
    unlinkedTools(source, tools).map((tool) => page + ": names " + tool.name + " but never links " + tool.url),
  passed: (pages) => "Checked outside tool links in " + pages.toString() + " documentation pages"
})

if (import.meta.main) void Effect.runPromise(program)
