import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

type Args = ReadonlyArray<string>

type RunnerCall = { readonly runs: "always" } | { readonly runs: "with-subcommand"; readonly subcommand: string }

const runnerBins: ReadonlyMap<string, RunnerCall> = new Map<string, RunnerCall>([
  ["checks-test", { runs: "always" }],
  ["checks-flake", { runs: "always" }],
  ["checks-mutation", { runs: "always" }],
  ["stryker", { runs: "always" }],
  ["vitest", { runs: "always" }],
  ["jest", { runs: "always" }],
  ["playwright", { runs: "with-subcommand", subcommand: "test" }]
])

const bunValueOptions: Args = [
  "--cwd", "-c", "--config", "--env-file", "-r", "--preload", "--require", "--import", "--tsconfig-override", "-d", "--define",
  "-l", "--loader", "--conditions", "--main-fields", "--extension-order", "--filter", "-F", "--shell", "--elide-lines", "--title", "--port"
]
const nodeValueOptions: Args = ["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--input-type", "--title"]
const evalOptions: Args = ["-e", "--eval", "-p", "--print"]

type Launch =
  | { readonly kind: "script"; readonly options: Args; readonly file: string; readonly args: Args }
  | { readonly kind: "none"; readonly options: Args }

const launchOf = (args: Args, valued: Args): Launch => {
  let at = 0
  while (at < args.length) {
    const word = args[at] ?? ""
    if (evalOptions.includes(word)) {
      return { kind: "none", options: args.slice(0, at) }
    }
    if (!word.startsWith("-")) {
      return { kind: "script", options: args.slice(0, at), file: word, args: args.slice(at + 1) }
    }
    at += valued.includes(word) ? 2 : 1
  }
  return { kind: "none", options: args }
}

const scriptOf = (tool: string, args: Args): Launch => {
  switch (tool) {
    case "node":
      return launchOf(args, nodeValueOptions)
    case "bun": {
      const first = launchOf(args, bunValueOptions)
      return first.kind === "script" && first.file === "run" ? launchOf(first.args, bunValueOptions) : first
    }
    default:
      return { kind: "none", options: [] }
  }
}

const bunBuiltins: Args = [
  "add", "a", "install", "i", "remove", "rm", "update", "audit", "dedupe", "prune", "outdated", "link", "unlink", "publish",
  "patch", "pm", "info", "why", "build", "init", "create", "c", "upgrade", "repl", "check", "test", "help", "completions"
]

interface BunOptions {
  readonly directory: string
  readonly config: string
  readonly bunFlag: string | null
}

const flagValue = (word: string, next: string | undefined): readonly [string, string | undefined] => {
  const equals = word.indexOf("=")
  return equals === -1 ? [word, next] : [word.slice(0, equals), word.slice(equals + 1)]
}

const bunOptionsOf = (options: Args, cwd: string): BunOptions => {
  let directory = cwd
  let config = "bunfig.toml"
  for (let at = 0; at < options.length; at += 1) {
    const word = options[at] ?? ""
    if (word === "--bun" || word === "-b") {
      return { directory, config, bunFlag: word }
    }
    const [flag, value] = flagValue(word, options.at(at + 1))
    if (flag === "--cwd" && value !== undefined) {
      directory = resolve(cwd, value)
    } else if ((flag === "--config" || flag === "-c") && value !== undefined) {
      config = value
    }
    if (bunValueOptions.includes(word)) {
      at += 1
    }
  }
  return { directory, config, bunFlag: null }
}

const setsRunBun = (parsed: unknown): boolean => {
  if (typeof parsed !== "object" || parsed === null || !("run" in parsed)) {
    return false
  }
  const run = parsed.run
  return typeof run === "object" && run !== null && "bun" in run && run.bun === true
}

const parseToml = (text: string): unknown => {
  try {
    return Bun.TOML.parse(text)
  } catch {
    return undefined
  }
}

const bunfigRunBun = (file: string): boolean => {
  const text = readText(file)
  return text !== null && setsRunBun(parseToml(text))
}

export const bunRuntimeOverride = (tool: string, args: Args, cwd: string): string | null => {
  if (tool !== "bun" && tool !== "bunx") {
    return null
  }
  const first = launchOf(args, bunValueOptions)
  const nested = tool === "bun" && first.kind === "script" && ["run", "x", "exec"].includes(first.file)
  const options = nested ? [...first.options, ...launchOf(first.args, bunValueOptions).options] : first.options
  const { directory, config, bunFlag } = bunOptionsOf(options, cwd)
  if (bunFlag !== null) {
    return bunFlag
  }
  if (first.kind === "none" || (tool === "bun" && bunBuiltins.includes(first.file))) {
    return null
  }
  const file = resolve(directory, config)
  return bunfigRunBun(file) ? file + " sets run.bun = true" : null
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const realFile = (file: string): string | null => {
  try {
    return realpathSync(file)
  } catch {
    return null
  }
}

const binsOf = (manifest: unknown): ReadonlyArray<readonly [string, string]> => {
  if (typeof manifest !== "object" || manifest === null || !("bin" in manifest)) {
    return []
  }
  const { bin } = manifest
  if (typeof bin === "string") {
    const name = "name" in manifest && typeof manifest.name === "string" ? manifest.name.split("/").at(-1) ?? "" : ""
    return [[name, bin]]
  }
  if (typeof bin !== "object" || bin === null) {
    return []
  }
  return Object.entries(bin).flatMap(([name, target]) => (typeof target === "string" ? [[name, target] as const] : []))
}

const readManifest = (file: string): unknown => {
  const text = readText(file)
  return text === null ? undefined : parseJson(text)
}

const owningPackage = (file: string): { readonly folder: string; readonly manifest: unknown } | null => {
  for (let folder = dirname(file), parent = dirname(folder); ; folder = parent, parent = dirname(folder)) {
    const manifest = readManifest(join(folder, "package.json"))
    if (manifest !== undefined) {
      return { folder, manifest }
    }
    if (parent === folder) {
      return null
    }
  }
}

const runnerOfFile = (real: string, args: Args): string | null => {
  const owner = owningPackage(real)
  if (owner === null) {
    return null
  }
  for (const [name, target] of binsOf(owner.manifest)) {
    const call = runnerBins.get(name)
    if (call === undefined || realFile(join(owner.folder, target)) !== real) {
      continue
    }
    if (call.runs === "always") {
      return name
    }
    if (args[0] === call.subcommand) {
      return name + " " + call.subcommand
    }
  }
  return null
}

// A package manager puts node_modules/.bin ahead of every stand-in, so a runner bin is only seen when its shebang starts bun or node.
export const interpretedRunner = (tool: string, args: Args, cwd: string): string | null => {
  const launch = scriptOf(tool, args)
  if (tool === "node" && launch.options.includes("--test")) {
    return "node --test"
  }
  const real = launch.kind === "script" ? realFile(resolve(cwd, launch.file)) : null
  return launch.kind === "script" && real !== null ? runnerOfFile(real, launch.args) : null
}
