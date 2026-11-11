export type HeavyDecision = "direct" | "queued" | "prioritized"

type Args = ReadonlyArray<string>

type BodyResult =
  | { readonly kind: "settled-direct" }
  | { readonly kind: "open"; readonly decision: HeavyDecision; readonly rest: Args }

const returned: BodyResult = { kind: "settled-direct" }

const fellThrough = (decision: HeavyDecision, rest: Args): BodyResult => ({ kind: "open", decision, rest })

const globPattern = (glob: string): RegExp =>
  new RegExp("^" + glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*") + "$")

const matchesAny = (word: string, globs: Args): boolean => globs.some((glob) => globPattern(glob).test(word))

const hasAny = (args: Args, words: Args): boolean => args.some((arg) => words.includes(arg))

const versionFlags: Args = ["--version", "-v", "--help", "-h"]
const watchFlags: Args = ["--watch", "--watchAll", "--watch-all", "--interactive", "--ui"]
const valueFlags: Args = [
  "--timeout", "--reporter", "--maxWorkers", "--max-workers", "--project", "--config", "--output", "--outDir",
  "--outdir", "--manifest-path", "--target", "-p", "-c", "-o"
]
const filterFlags: Args = ["--changed", "-t", "--test-name-pattern", "-g", "--grep", "-k", "-run"]
const testFiles: Args = ["*.test.*", "*.spec.*", "*_test.go", "test_*.py", "*_test.py", "*/test_*.py"]
const wholeTree: Args = [".", "./..."]

const interactive = (args: Args): boolean => hasAny(args, watchFlags) || hasAny(args, versionFlags)

const narrowed = (args: Args, names: (word: string) => boolean): boolean => {
  let at = 0
  while (at < args.length) {
    const word = args[at] ?? ""
    if (filterFlags.includes(word) || names(word)) {
      return true
    }
    at += valueFlags.includes(word) ? 2 : 1
  }
  return false
}

const pathOrTestFile = (word: string): boolean =>
  matchesAny(word, testFiles) || (!word.startsWith("-") && !wholeTree.includes(word) && word.includes("/"))

const anyBareWord = (word: string): boolean => !word.startsWith("-") && !wholeTree.includes(word)

const targeted = (args: Args): boolean => narrowed(args, pathOrTestFile)

const targetedBare = (args: Args): boolean => narrowed(args, anyBareWord)

const queueOn = (prioritized: boolean): HeavyDecision => (prioritized ? "prioritized" : "queued")

const execTool = (args: Args): HeavyDecision => {
  const [tool = "", ...rest] = args
  if (tool.startsWith("checks-")) {
    return queueOn(targeted(rest))
  }
  switch (tool) {
    case "vitest":
      return vitestDecision(rest)
    case "jest":
      return queueOn(targetedBare(rest))
    case "tsc":
      return rest.includes("-w") ? "direct" : queueOn(targeted(rest))
    case "playwright":
    case "eslint":
    case "oxlint":
      return queueOn(targeted(rest))
    default:
      return "direct"
  }
}

const vitestDecision = (args: Args): HeavyDecision => {
  if (["watch", "dev"].includes(args[0] ?? "") || args.includes("-w")) {
    return "direct"
  }
  return queueOn(targetedBare(args[0] === "run" ? args.slice(1) : args))
}

const watchScripts: Args = ["", "dev", "start", "serve", "preview", "watch", "storybook", "*:watch", "*:ui", "*:dev"]
const heavyScripts: Args = [
  "test", "tests", "lint", "typecheck", "build", "check", "checks", "e2e", "coverage", "mutation", "checks-*", "test:*",
  "build:*", "lint:*", "typecheck:*", "vitest", "jest", "tsc", "eslint", "oxlint", "playwright"
]

const skipLeading = (args: Args, valued: Args, single: (word: string) => boolean): Args => {
  let at = 0
  while (at < args.length) {
    const word = args[at] ?? ""
    if (valued.includes(word)) {
      at += 2
    } else if (single(word)) {
      at += 1
    } else {
      break
    }
  }
  return args.slice(at)
}

const runScript = (args: Args): HeavyDecision => {
  const [script = "", ...rest] = skipLeading(args, ["--filter", "--cwd", "-w", "--workspace", "--prefix"], (word) => word.startsWith("-"))
  if (matchesAny(script, watchScripts) || !matchesAny(script, heavyScripts) || hasAny(rest, watchFlags)) {
    return "direct"
  }
  return queueOn(targeted(rest))
}

const bunBody = (all: Args): BodyResult => {
  const args = skipLeading(all, ["--filter"], (word) => word.startsWith("--filter="))
  if (args.length === 0 || interactive(args)) {
    return returned
  }
  const [sub = "", ...rest] = args
  switch (sub) {
    case "test":
      return fellThrough(queueOn(targetedBare(rest)), rest)
    case "run":
      return fellThrough(runScript(rest), rest)
    case "x":
      return fellThrough(execTool(rest), rest)
    case "build":
      return fellThrough("queued", args)
    default:
      return fellThrough(execTool(args), args)
  }
}

const npxBody = (args: Args): BodyResult =>
  args.length === 0 || interactive(args) ? returned : fellThrough(execTool(args), args)

const managerScripts = (named: Args): Args => [
  ...named, "lint", "typecheck", "build", "check", "checks", "e2e", "coverage", "mutation", "checks-*", "test:*",
  "build:*", "lint:*", "typecheck:*"
]

const managerBody = (scripts: Args) => (all: Args): BodyResult => {
  const args = skipLeading(
    all,
    ["--filter", "-F", "--workspace", "-w", "--prefix", "workspace"],
    (word) => matchesAny(word, ["--filter=*", "--workspace=*", "--prefix=*", "-r", "--recursive"])
  )
  if (args.length === 0 || interactive(args)) {
    return returned
  }
  const [sub = "", ...rest] = args
  if (sub === "run") {
    return fellThrough(runScript(rest), rest)
  }
  if (sub === "exec") {
    const tool = rest[0] === "--" ? rest.slice(1) : rest
    return fellThrough(execTool(tool), tool)
  }
  if (matchesAny(sub, ["*:watch", "*:ui", "*:dev"])) {
    return returned
  }
  if (matchesAny(sub, scripts)) {
    return fellThrough(queueOn(targeted(rest)), rest)
  }
  return fellThrough(execTool(args), args)
}

const npmBody = managerBody(managerScripts(["test", "tests", "t"]))
const pnpmBody = managerBody(managerScripts(["test", "tests"]))

const guarded = (decide: (args: Args) => BodyResult) => (args: Args): BodyResult =>
  interactive(args) ? returned : decide(args)

const vitestBody = guarded((args) => {
  const decision = vitestDecision(args)
  return decision === "direct" ? returned : fellThrough(decision, args[0] === "run" ? args.slice(1) : args)
})

const queueAll = (narrow: (args: Args) => boolean) => guarded((args) => fellThrough(queueOn(narrow(args)), args))

const tscBody = guarded((args) => (args.includes("-w") ? returned : fellThrough(queueOn(targeted(args)), args)))

const playwrightBody = guarded((args) =>
  args[0] === "test" ? fellThrough(queueOn(targeted(args.slice(1))), args.slice(1)) : fellThrough("direct", args)
)

const subcommandBody = (heavy: Args) => (args: Args): BodyResult => {
  const [sub = "", ...rest] = args
  if (sub === "" || sub.startsWith("-") || interactive(args)) {
    return returned
  }
  return heavy.includes(sub) ? fellThrough(queueOn(targeted(rest)), rest) : fellThrough("direct", args)
}

const xcodeBody = (args: Args): BodyResult => (hasAny(args, versionFlags) ? returned : fellThrough("queued", args))

const xcrunBody = (args: Args): BodyResult =>
  fellThrough(args[0] === "simctl" && ["boot", "io"].includes(args[1] ?? "") ? "queued" : "direct", args)

const builtinBodies: ReadonlyMap<string, (args: Args) => BodyResult> = new Map([
  ["bun", bunBody],
  ["bunx", npxBody],
  ["npx", npxBody],
  ["npm", npmBody],
  ["pnpm", pnpmBody],
  ["yarn", pnpmBody],
  ["vitest", vitestBody],
  ["jest", queueAll(targetedBare)],
  ["tsc", tscBody],
  ["pytest", queueAll(targeted)],
  ["oxlint", queueAll(targeted)],
  ["eslint", queueAll(targeted)],
  ["playwright", playwrightBody],
  ["go", subcommandBody(["test", "build", "vet"])],
  ["cargo", subcommandBody(["test", "build", "clippy"])],
  ["xcodebuild", xcodeBody],
  ["xcrun", xcrunBody]
])

const rank: Readonly<Record<HeavyDecision, number>> = { direct: 0, queued: 1, prioritized: 2 }

const atLeast = (current: HeavyDecision, next: HeavyDecision): HeavyDecision => (rank[next] > rank[current] ? next : current)

const configuredDecision = (tool: string, commands: Args, args: Args): HeavyDecision => {
  const words = commands.map((entry) => entry.trim().split(" "))
  if (commands.some((entry) => entry.trim() === tool)) {
    return interactive(args) ? "direct" : queueOn(targeted(args))
  }
  const subs = words.filter((parts) => parts.length === 2 && parts[0] === tool).map((parts) => parts[1] ?? "").filter((sub) => sub !== "")
  const [sub = "", ...rest] = args
  if (subs.length === 0 || interactive(args) || !matchesAny(sub, subs)) {
    return "direct"
  }
  return queueOn(targeted(rest))
}

export const classifyHeavyCall = (tool: string, commands: Args, args: Args): HeavyDecision => {
  const body = builtinBodies.get(tool)
  const result = body === undefined ? fellThrough("direct", args) : body(args)
  if (result.kind === "settled-direct") {
    return "direct"
  }
  return atLeast(result.decision, configuredDecision(tool, commands, result.rest))
}

export const decisionWords = (decision: HeavyDecision): string => {
  switch (decision) {
    case "direct":
      return "0 0"
    case "queued":
      return "1 0"
    case "prioritized":
      return "1 1"
  }
}

export interface ClassifyRequest {
  readonly tool: string
  readonly commands: ReadonlyArray<string>
}

export interface ClassifyCall {
  readonly request: ClassifyRequest
  readonly args: ReadonlyArray<string>
}

export const classifyArgv = (request: ClassifyRequest): ReadonlyArray<string> => [
  request.tool,
  String(request.commands.length),
  ...request.commands
]

export const parseClassifyArgv = (argv: ReadonlyArray<string>): ClassifyCall | null => {
  const [tool = "", countWord = "", ...rest] = argv
  const count = Number(countWord)
  if (argv.length < 2 || !/^\d+$/.test(countWord) || count > rest.length) {
    return null
  }
  return { request: { tool, commands: rest.slice(0, count) }, args: rest.slice(count) }
}
