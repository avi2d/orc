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
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
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
