import { Schema } from "effect"

const TEST_TREE = "tests/"
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

function importedFile(path: string, files: ReadonlySet<string>): readonly string[] {
  const bare = path.replace(/\.m?js$/, "")
  const direct = [path, ...CANDIDATE_EXTENSIONS.map((extension) => bare + extension)].filter((file) => files.has(file))
  if (direct.length > 0) return direct
  return CANDIDATE_EXTENSIONS.map((extension) => `${path}/index${extension}`).filter((file) => files.has(file))
}

function importsOf(file: string, text: string, files: ReadonlySet<string>): readonly string[] {
  const directory = file.slice(0, Math.max(file.lastIndexOf("/"), 0))
  return [...text.matchAll(IMPORT)].flatMap(([, throughImport = "", throughRequire = ""]) => importedFile(resolved(directory, throughImport || throughRequire), files))
}

export type Narrowing =
  | { readonly kind: "full"; readonly because: string }
  | { readonly kind: "files"; readonly files: readonly string[] }

type SharedChange = { readonly path: string; readonly reason: string }

type SelfReference = {
  readonly name: string
  readonly exports: ReadonlyMap<string, string>
}

export type Repository = {
  readonly files: readonly string[]
  readonly sources: ReadonlyMap<string, string>
  readonly bins: ReadonlyMap<string, string>
  readonly self: SelfReference | undefined
  readonly preloads: readonly string[]
}

const FIXTURES = "tests/fixtures/"
const WORKFLOWS = ".github/"
const TEST_FILE = /\.test\.tsx?$/
const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"])
const TOOL_PINS = new Set([".bun-version", ".npmrc", ".nvmrc", ".node-version", ".tool-versions"])
const CONFIG = /(?:^|\.)config\.(?:[cm]?[jt]s|json)$/
const STYLESHEET = /\.(?:css|scss|sass|less|pcss|styl)$/
const FONT = /\.(?:woff2?|ttf|otf|eot)$/
const LAYOUT = /^layout\./i
const LISTED_SEGMENTS = /["'`][ \t]*,[ \t]*["'`]/g
const TOKEN = /[\w.@/-]+/g
const LEADING_HOPS = /^(?:\.{1,2}\/|\/)+/
const BARE_IMPORT = /(?:from|import)\s*\(?\s*["']([^"'.][^"']*)["']|require\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g
const BUILT = "the build"

const CI_CONFIGS = new Set([
  "package.json",
  "bunfig.toml",
  "commitlint.config.ts",
  "oxlint.config.ts",
  "knip.config.ts",
  "knip-base.json",
  "dependency-cruiser.config.js",
  "dependency-cruiser.config.ts"
])

const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
const directoryNode = (directory: string): string => directory + "/"

const isWorkflowPath = (path: string): boolean => {
  const basename = basenameOf(path)
  return path.startsWith(".github/") || CI_CONFIGS.has(basename) || /^tsconfig(\..*)?\.json$/.test(basename)
}

function sharedReason(path: string, preloads: ReadonlySet<string>): string | undefined {
  if (path.startsWith(FIXTURES)) return undefined
  const name = basenameOf(path)
  const directories = path.split("/").slice(0, -1)
  if (LOCKFILES.has(name)) return "a lockfile"
  if ((isWorkflowPath(path) && !path.startsWith(WORKFLOWS)) || CONFIG.test(name) || TOOL_PINS.has(name)) {
    return "a config every test runs under"
  }
  if (preloads.has(path)) return "a file Bun preloads into every test"
  if (path.startsWith(TEST_TREE) && !TEST_FILE.test(path)) return "a test helper"
  if (STYLESHEET.test(name)) return "a stylesheet"
  if (FONT.test(name) || directories.includes("fonts")) return "a font"
  if (directories.includes("layouts") || LAYOUT.test(name)) return "a layout"
  return undefined
}

function mentionKeys(path: string): readonly string[] {
  const segments = path.split("/")
  const keys = [path]
  for (let start = 1; start <= segments.length - 2; start += 1) keys.push(segments.slice(start).join("/"))
  return keys
}

function directoriesOf(path: string): readonly string[] {
  if (!path.startsWith(FIXTURES)) return []
  const segments = path.split("/")
  return segments.slice(1).map((_, end) => segments.slice(0, end + 1).join("/"))
}

function selfTarget(spec: string, self: SelfReference): string | undefined {
  if (spec !== self.name && !spec.startsWith(self.name + "/")) return undefined
  const subpath = spec === self.name ? "." : "./" + spec.slice(self.name.length + 1)
  if (self.exports.size === 0) return resolved("", subpath === "." ? "index" : subpath)
  const exact = self.exports.get(subpath)
  if (exact !== undefined) return exact
  for (const [key, target] of self.exports) {
    const star = key.indexOf("*")
    if (star === -1) continue
    const [before, after] = [key.slice(0, star), key.slice(star + 1)]
    if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= key.length - 1) {
      return target.replace("*", subpath.slice(before.length, subpath.length - after.length))
    }
  }
  return BUILT
}

type Graph = { readonly readers: ReadonlyMap<string, ReadonlySet<string>>; readonly builtReaders: ReadonlySet<string> }

function linkTo(readers: Map<string, Set<string>>, read: string, reader: string): void {
  if (read === reader) return
  readers.set(read, (readers.get(read) ?? new Set()).add(reader))
}

function selfImports(text: string, self: SelfReference, known: ReadonlySet<string>): readonly string[] {
  return [...text.matchAll(BARE_IMPORT)].flatMap(([, viaImport = "", viaRequire = ""]) => {
    const target = selfTarget(viaImport || viaRequire, self)
    if (target === undefined || target === BUILT) return target === undefined ? [] : [BUILT]
    const found = importedFile(target, known)
    return found.length === 0 ? [BUILT] : found
  })
}

function mentioned(text: string, index: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const joined = text.replaceAll(LISTED_SEGMENTS, "/")
  return [...joined.matchAll(TOKEN)].flatMap(([token]) => index.get(token.replace(LEADING_HOPS, "").replace(/\/$/, "")) ?? [])
}

function mentionIndex(repository: Repository, known: ReadonlySet<string>): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>()
  const add = (key: string, node: string) => index.set(key, [...(index.get(key) ?? []), node])
  const directories = new Set([...known].flatMap(directoriesOf))
  for (const file of known) for (const key of mentionKeys(file)) add(key, file)
  for (const directory of directories) for (const key of mentionKeys(directory)) if (key.includes("/")) add(key, directoryNode(directory))
  for (const [bin, file] of repository.bins) add(bin, file)
  return index
}

function graphOf(repository: Repository, changed: readonly string[]): Graph {
  const known = new Set([...repository.files, ...changed])
  const index = mentionIndex(repository, known)
  const readers = new Map<string, Set<string>>()
  const builtReaders = new Set<string>()
  for (const [file, text] of repository.sources) {
    const self = repository.self === undefined ? [] : selfImports(text, repository.self, known)
    if (self.includes(BUILT)) builtReaders.add(file)
    const named = file.startsWith(TEST_TREE) ? mentioned(text, index) : []
    for (const read of [...importsOf(file, text, known), ...self.filter((target) => target !== BUILT), ...named]) {
      linkTo(readers, read, file)
    }
  }
  return { readers, builtReaders }
}

function reach(graph: Graph, changed: readonly string[], sources: ReadonlyMap<string, string>): ReadonlySet<string> {
  const reached = new Set<string>()
  const pending = [...changed]
  const builds = changed.some((path) => sources.has(path) && !path.startsWith(TEST_TREE))
  if (builds) pending.push(...graph.builtReaders)
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (reached.has(node)) continue
    reached.add(node)
    pending.push(...(graph.readers.get(node) ?? []))
    if (!node.endsWith("/")) pending.push(...directoriesOf(node).map(directoryNode))
  }
  return reached
}

function preloadClosure(repository: Repository): ReadonlySet<string> {
  const known = new Set(repository.files)
  const loaded = new Set<string>()
  for (let pending = [...repository.preloads]; pending.length > 0; ) {
    const file = pending.pop() ?? ""
    if (loaded.has(file)) continue
    loaded.add(file)
    pending.push(...importsOf(file, repository.sources.get(file) ?? "", known))
  }
  return loaded
}

export function narrowTests(changed: readonly string[], repository: Repository, tests: readonly string[]): Narrowing {
  if (changed.length === 0) return { kind: "full", because: "the pull request changes no file" }
  const shared = sharedChanges(changed, repository).at(0)
  if (shared !== undefined) return { kind: "full", because: `the pull request changes ${shared.path}, ${shared.reason}` }
  return { kind: "files", files: reachedTests(changed, repository, tests) }
}

function sharedChanges(changed: readonly string[], repository: Repository): readonly SharedChange[] {
  const preloads = preloadClosure(repository)
  return changed.flatMap((path) => {
    const reason = sharedReason(path, preloads)
    return reason === undefined ? [] : [{ path, reason }]
  })
}

function reachedTests(changed: readonly string[], repository: Repository, tests: readonly string[]): readonly string[] {
  const reached = reach(graphOf(repository, changed), changed, repository.sources)
  return tests.filter((test) => reached.has(test))
}
