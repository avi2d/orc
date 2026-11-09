import type { HeavyConfig } from "../orc-config"

export const heavyGroup = "heavy"

export const standinDirSuffix = "/heavy/bin"

export const heavyBinDir = (home: string): string => home + standinDirSuffix

export const withHeavyPath = (home: string, path: string): string => heavyBinDir(home) + ":" + path

export interface HeavyDecision {
  readonly queue: boolean
  readonly priority: number
}

const idle = (priority: number): HeavyDecision => ({ queue: true, priority })

const direct: HeavyDecision = { queue: false, priority: 0 }

const versionOf = (args: ReadonlyArray<string>): boolean =>
  args.some((arg) => arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h")

const watching = (args: ReadonlyArray<string>): boolean =>
  args.some((arg) => arg === "--watch" || arg === "--watchAll" || arg === "--watch-all" || arg === "--interactive")

const testFile = (arg: string): boolean =>
  !arg.startsWith("-") && (/\.(test|spec)\.[A-Za-z]+$/.test(arg) || /_test\.go$/.test(arg) || /(^|\/)test_[^/]*\.py$/.test(arg) || /[^/]*_test\.py$/.test(arg))

const packagePath = (arg: string): boolean =>
  !arg.startsWith("-") && arg.includes("/") && arg !== "./..." && arg !== "."

const targeted = (args: ReadonlyArray<string>): boolean =>
  args.some((arg) =>
    arg === "--changed" || arg === "-t" || arg === "--test-name-pattern" || arg === "-g" || arg === "--grep" || arg === "-k" || arg === "-run" || testFile(arg) || packagePath(arg))

const lightScripts: ReadonlySet<string> = new Set(["dev", "start", "serve", "preview", "watch", "storybook"])

const heavyScripts: ReadonlySet<string> = new Set(["test", "tests", "lint", "typecheck", "build", "check", "checks", "e2e", "coverage", "mutation"])

const scriptToken = (token: string): boolean =>
  lightScripts.has(token) || heavyScripts.has(token) || token.startsWith("checks-") || token.startsWith("test:")

const runScript = (args: ReadonlyArray<string>): { readonly script: string; readonly rest: ReadonlyArray<string> } | null => {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ""
    if (scriptToken(token)) {
      return { script: token, rest: args.slice(index + 1) }
    }
  }
  return null
}

// An unknown run script runs directly: a server under a custom name would hold the only slot forever.
const bunRun = (args: ReadonlyArray<string>): HeavyDecision => {
  if (versionOf(args)) {
    return direct
  }
  const found = runScript(args)
  if (found === null || lightScripts.has(found.script)) {
    return direct
  }
  return targeted(found.rest) ? idle(1) : idle(0)
}

const bunDecision = (args: ReadonlyArray<string>): HeavyDecision => {
  const [first = "", ...rest] = args
  if (first === "" || watching(args) || versionOf(args)) {
    return direct
  }
  if (first === "test") {
    return targeted(rest) ? idle(1) : idle(0)
  }
  if (first === "run") {
    return bunRun(rest)
  }
  if (first === "x") {
    return execDecision(rest)
  }
  if (first === "build") {
    return idle(0)
  }
  return direct
}

const execToolNames: ReadonlySet<string> = new Set(["vitest", "playwright", "jest", "tsc", "eslint", "oxlint"])

const execDecision = (args: ReadonlyArray<string>): HeavyDecision => {
  const [first = "", ...rest] = args
  if (first === "" || first.startsWith("-") || watching(args) || versionOf(args)) {
    return direct
  }
  if (first.startsWith("checks-") || execToolNames.has(first)) {
    return targeted(rest) ? idle(1) : idle(0)
  }
  return direct
}

const bunxDecision = (args: ReadonlyArray<string>): HeavyDecision => execDecision(args)

const testRunner = (args: ReadonlyArray<string>): HeavyDecision => {
  if (watching(args) || versionOf(args)) {
    return direct
  }
  return targeted(args) ? idle(1) : idle(0)
}

const subcommand = (args: ReadonlyArray<string>, heavy: ReadonlySet<string>): HeavyDecision | null => {
  const [first = "", ...rest] = args
  if (first === "" || first.startsWith("-") || watching(args) || versionOf(args)) {
    return direct
  }
  return heavy.has(first) ? (targeted(rest) ? idle(1) : idle(0)) : null
}

const goDecision = (args: ReadonlyArray<string>): HeavyDecision =>
  subcommand(args, new Set(["test", "build", "vet"])) ?? direct

const cargoDecision = (args: ReadonlyArray<string>): HeavyDecision =>
  subcommand(args, new Set(["test", "build", "clippy"])) ?? direct

const xcrunDecision = (args: ReadonlyArray<string>): HeavyDecision => {
  const [first = "", second = ""] = args
  return first === "simctl" && (second === "boot" || second === "io") ? idle(0) : direct
}

const playwrightDecision = (args: ReadonlyArray<string>): HeavyDecision => {
  if (watching(args) || versionOf(args)) {
    return direct
  }
  const [first = "", ...rest] = args
  if (first === "test") {
    return targeted(rest) ? idle(1) : idle(0)
  }
  return direct
}

const scriptRunner = (args: ReadonlyArray<string>): HeavyDecision => {
  const [first = "", ...rest] = args
  if (first === "" || watching(args) || versionOf(args)) {
    return direct
  }
  if (first === "test") {
    return targeted(rest) ? idle(1) : idle(0)
  }
  if (first === "run") {
    return bunRun(rest)
  }
  if (first === "exec") {
    return execDecision(rest)
  }
  if (heavyScripts.has(first) || first.startsWith("checks-") || first.startsWith("test:")) {
    return targeted(rest) ? idle(1) : idle(0)
  }
  return direct
}

export const defaultHeavyTools: ReadonlyArray<string> = [
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "vitest",
  "playwright",
  "jest",
  "go",
  "cargo",
  "pytest",
  "tsc",
  "oxlint",
  "eslint",
  "xcodebuild",
  "xcrun"
]

const builtin = (tool: string, args: ReadonlyArray<string>): HeavyDecision | null => {
  switch (tool) {
    case "bun": return bunDecision(args)
    case "bunx":
    case "npx": return bunxDecision(args)
    case "npm":
    case "pnpm":
    case "yarn": return scriptRunner(args)
    case "vitest":
    case "jest":
    case "pytest":
    case "tsc":
    case "oxlint":
    case "eslint": return testRunner(args)
    case "playwright": return playwrightDecision(args)
    case "go": return goDecision(args)
    case "cargo": return cargoDecision(args)
    case "xcodebuild": return versionOf(args) ? direct : idle(0)
    case "xcrun": return xcrunDecision(args)
    default: return null
  }
}

const extraEntry = (entry: string): { readonly tool: string; readonly sub: string | null } => {
  const cut = entry.indexOf(" ")
  return cut === -1 ? { tool: entry, sub: null } : { tool: entry.slice(0, cut), sub: entry.slice(cut + 1) }
}

const extraEntryDecision = (tool: string, args: ReadonlyArray<string>, want: string, sub: string | null): HeavyDecision | null => {
  if (want === "" || want !== tool) {
    return null
  }
  if (versionOf(args) || watching(args)) {
    return direct
  }
  if (sub === null) {
    return targeted(args) ? idle(1) : idle(0)
  }
  const [first = "", ...rest] = args
  if (first !== sub) {
    return null
  }
  return targeted(rest) ? idle(1) : idle(0)
}

const extraDecision = (tool: string, args: ReadonlyArray<string>, extra: ReadonlyArray<string>): HeavyDecision | null => {
  for (const entry of extra) {
    const { tool: want, sub } = extraEntry(entry.trim())
    const decision = extraEntryDecision(tool, args, want, sub)
    if (decision !== null) {
      return decision
    }
  }
  return null
}

export const classifyHeavy = (tool: string, args: ReadonlyArray<string>, extra: ReadonlyArray<string>): HeavyDecision =>
  builtin(tool, args) ?? extraDecision(tool, args, extra) ?? direct

export interface HeavySettings {
  readonly group: string
  readonly commands: ReadonlyArray<string>
  readonly limit: "auto" | "none"
}

export const resolveHeavy = (config: HeavyConfig | undefined): HeavySettings => ({
  group: config?.group ?? heavyGroup,
  commands: config?.commands ?? [],
  limit: config?.limit ?? "auto"
})
