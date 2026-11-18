import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const docs = join(import.meta.dir, "..", "docs")
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

const files = await markdownFiles(docs)
if (files.length === 0) throw new Error("No documentation pages found")

const failures: string[] = []
for (const file of files) {
  const name = relative(docs, file)
  const source = await readFile(file, "utf8")
  const prose = source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
  const words = prose.trim().split(/\s+/).length
  const title = /^#\s+\S.*$/m.exec(prose)
  const afterTitle = title ? prose.slice(title.index + title[0].length) : ""
  if (words > 400 && !/^#{2,6}\s+\S/m.test(afterTitle)) failures.push(`${name}: ${words} words without a section heading`)
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log(`Checked section headings in ${files.length} documentation pages`)
}
