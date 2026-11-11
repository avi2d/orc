const args = Bun.argv.slice(2)
const version = args.at(0)
const from = args.at(1) ?? `${Bun.env.HOME}/.config/herdr-app`
if (version === undefined) {
  console.error("usage: bun scripts/copy-app-types.ts <App version> [App home]")
  process.exit(1)
}

const quotes = new Set(["'", "\"", "`"])

const stringEnd = (source: string, at: number): number => {
  const quote = source.charAt(at)
  let end = at + 1
  while (end < source.length && source.charAt(end) !== quote) {
    end += source.charAt(end) === "\\" ? 2 : 1
  }
  return end + 1
}

const commentEnd = (source: string, at: number): number | undefined => {
  if (source.startsWith("//", at)) {
    const end = source.indexOf("\n", at)
    return end === -1 ? source.length : end
  }
  return source.startsWith("/*", at) ? source.indexOf("*/", at + 2) + 2 : undefined
}

// The comment gate refuses the App's doc blocks.
const withoutComments = (source: string): string => {
  let out = ""
  let at = 0
  while (at < source.length) {
    const skip = commentEnd(source, at)
    const next = skip ?? (quotes.has(source.charAt(at)) ? stringEnd(source, at) : at + 1)
    if (skip === undefined) out += source.slice(at, next)
    at = next
  }
  return out.split("\n").filter((line) => line.trim() !== "").map((line) => line.trimEnd()).join("\n") + "\n"
}

// dependency-cruiser's parser refuses an import type after extends.
const withoutImportedBases = (source: string): string =>
  source.replaceAll(
    /^( *)(export interface \w+ extends )import\("([^"]+)"\)\.(\w+)/gm,
    (_, indent: string, head: string, module: string, base: string) =>
      `${indent}type Imported${base} = import("${module}").${base};\n${indent}${head}Imported${base}`
  )

for (const name of ["gpui-kit.d.ts", "herdr.d.ts"]) {
  const text = await Bun.file(`${from}/${name}`).text()
  const declarations = withoutImportedBases(withoutComments(text))
  const module = name === "herdr.d.ts" ? `declare module "herdr" {\n${declarations}}\n` : declarations
  await Bun.write(`${import.meta.dir}/../app-types/${version}/${name}`, module)
}
