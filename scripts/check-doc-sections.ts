import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const docs = join(import.meta.dir, "..", "docs")
const limit = 300
const markdownFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== "adr" && !entry.name.startsWith(".")) return markdownFiles(path)
    if (entry.isFile() && entry.name.endsWith(".md")) return [path]
    return []
  }))
  return paths.flat()
}
const wordsOf = (value: string): number => {
  const clean = value.trim()
  return clean === "" ? 0 : clean.split(/\s+/).length
}
const files = await markdownFiles(docs)
if (files.length === 0) throw new Error("No documentation pages found")
const failures: string[] = []
for (const file of files) {
  const name = relative(docs, file)
  const source = await readFile(file, "utf8")
  const withoutFrontmatter = source.replace(/^---\n[\s\S]*?\n---\n/, "")
  const prose = withoutFrontmatter.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
  const matches = [...prose.matchAll(/^#{1,6}\s+\S.*$/gm)]
  if (matches.length === 0) {
    if (wordsOf(prose) > limit) failures.push(`${name}: ${wordsOf(prose)} words with no heading (limit ${limit})`)
    continue
  }
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? prose.length) : prose.length
    const count = wordsOf(prose.slice(start, end))
    if (count > limit) failures.push(`${name}: ${count} words after "${match[0]}" (limit ${limit})`)
  }
}
if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log(`Checked section lengths in ${files.length} documentation pages`)
}
