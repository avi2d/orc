import { Schema } from "effect"

export const TEST_TREE = "tests/"
const CANDIDATE_EXTENSIONS = [".tsx", ".ts", ".mts", ".cts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".node"]

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']*)["']|require\s*\(\s*["'](\.[^"']*)["']\s*\)/g

const Bunfig = Schema.Struct({
  test: Schema.optionalKey(Schema.Struct({ preload: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])) }))
})

export const decodeBunfig = Schema.decodeUnknownEffect(Bunfig)

export function preloadPaths(bunfig: typeof Bunfig.Type): readonly string[] {
  const preload = bunfig.test?.preload ?? []
  return (typeof preload === "string" ? [preload] : preload).map((entry) => resolved("", entry))
}

export function resolved(directory: string, spec: string): string {
  const parts: string[] = []
  for (const part of `${directory}/${spec}`.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== "." && part !== "") parts.push(part)
  }
  return parts.join("/")
}

export function importedFile(path: string, files: ReadonlySet<string>): readonly string[] {
  const bare = path.replace(/\.m?js$/, "")
  const direct = [path, ...CANDIDATE_EXTENSIONS.map((extension) => bare + extension)].filter((file) => files.has(file))
  if (direct.length > 0) return direct
  return CANDIDATE_EXTENSIONS.map((extension) => `${path}/index${extension}`).filter((file) => files.has(file))
}

export function importsOf(file: string, text: string, files: ReadonlySet<string>): readonly string[] {
  const directory = file.slice(0, Math.max(file.lastIndexOf("/"), 0))
  return [...text.matchAll(IMPORT)].flatMap(([, throughImport = "", throughRequire = ""]) => importedFile(resolved(directory, throughImport || throughRequire), files))
}
