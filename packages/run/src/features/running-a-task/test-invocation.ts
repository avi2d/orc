import type { Path } from "effect"
import { isTestCall } from "../../entities/heavy-queue/index"
import type { ShellCall } from "./shell-calls"

type Manager = "bun" | "npm" | "pnpm" | "yarn"

type Target =
  | { readonly kind: "suite" }
  | { readonly kind: "script"; readonly cwd: string; readonly name: string; readonly executableFallback: boolean }
  | { readonly kind: "shell"; readonly cwd: string; readonly command: string }

const suite: Target = { kind: "suite" }

const bunCommands = new Set([
  "repl", "install", "i", "ci", "add", "a", "remove", "rm", "update", "audit", "dedupe",
  "prune", "outdated", "link", "unlink", "publish", "patch", "patch-commit", "pm", "info", "why", "build", "init", "create",
  "c", "upgrade", "completions", "help"
])
const pnpmCommands = new Set([
  "add", "install", "i", "ci", "update", "up", "upgrade", "remove", "rm", "uninstall", "un", "link", "ln", "unlink", "import",
  "rebuild", "rb", "prune", "fetch", "patch", "patch-commit", "patch-remove", "audit", "list", "ls",
  "outdated", "why", "licenses", "dedupe", "deploy", "pack", "publish", "root", "bin", "store", "server", "setup", "env",
  "init", "create", "cat-file", "cat-index", "find-hash", "config", "c", "get", "set", "doctor",
  "self-update", "approve-builds", "ignored-builds", "recursive", "m", "multi", "help"
])
const yarnCommands = new Set([
  "add", "audit", "autoclean", "bin", "cache", "config", "constraints", "create", "dedupe", "explain",
  "generate-lock-entry", "global", "help", "import", "info", "init", "install", "licenses", "link", "list", "login", "logout",
  "node", "npm", "outdated", "owner", "pack", "patch", "patch-commit", "plugin", "policies", "publish", "rebuild", "remove",
  "search", "set", "stage", "tag", "team", "unlink", "unplug", "up", "upgrade", "upgrade-interactive", "version",
  "versions", "why", "workspace", "workspaces"
])
const npmScriptCommands = new Set(["start", "stop", "restart"])
const installTestCommands: Readonly<Record<Manager, ReadonlySet<string>>> = {
  bun: new Set(),
  npm: new Set(["it", "cit", "install-test", "install-ci-test"]),
  pnpm: new Set(["it", "install-test"]),
  yarn: new Set()
}

const runsScriptByName: Readonly<Record<Manager, (verb: string) => boolean>> = {
  bun: (verb) => !bunCommands.has(verb),
  npm: (verb) => npmScriptCommands.has(verb),
  pnpm: (verb) => !pnpmCommands.has(verb),
  yarn: (verb) => !yarnCommands.has(verb)
}

const leafName = (word: string): string => word.split(/[/\\]/).at(-1) ?? ""
const executableName = (word: string): string => leafName(word).replace(/@[^@]+$/, "").replace(/\.(?:exe|cmd|bat)$/, "")
const isE2eTarget = (word: string): boolean => /(^|[:_-])e2e(?:[:_.-]|$)/.test(leafName(word))

export const isTestExecutable = (program: string, args: ReadonlyArray<string | null> = []): boolean =>
  isTestCall(executableName(program), args.map((word) => word ?? "")) || isE2eTarget(program)

type OptionTable = {
  readonly valued: ReadonlySet<string>
  readonly directory: ReadonlySet<string>
  readonly workspace: ReadonlySet<string>
}

const optionTable = (
  valued: ReadonlyArray<string>,
  directory: ReadonlyArray<string> = [],
  workspace: ReadonlyArray<string> = []
): OptionTable => ({
  valued: new Set([...valued, ...directory, ...workspace]),
  directory: new Set(directory),
  workspace: new Set(workspace)
})

const noOptionValues = optionTable([])
const managerOptions: Readonly<Record<Manager, OptionTable>> = {
  bun: optionTable([
    "--filter", "-F", "--elide-lines", "--env-file", "--config", "-c", "--preload", "-r", "--require", "--import",
    "--conditions", "--tsconfig-override", "--define", "-d", "--loader", "-l", "--package", "-p"
  ], ["--cwd"]),
  npm: optionTable(["--package", "-p", "--call", "-c"], ["--prefix", "-C"], ["--workspace", "-w"]),
  pnpm: optionTable(["--filter", "-F", "--filter-prod", "--package"], ["--dir", "-C"]),
  yarn: optionTable(["--package", "-p"], ["--cwd"])
}
const runnerOptions = optionTable(["--package", "-p", "--call", "-c"])
const envOptions = optionTable(["--unset", "-u"], ["--chdir", "-C"])
const dotenvOptions = optionTable(["-e", "-v", "-p"])
const execOptions = optionTable(["-a"])

const directoryForOption = (table: OptionTable, name: string, value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null
  if (table.directory.has(name) || (table.workspace.has(name) && /[./\\]/.test(value))) return value
  return null
}

const optionAt = (table: OptionTable, flag: string, following: string | null | undefined) => {
  const equal = flag.indexOf("=")
  const name = equal === -1 ? flag : flag.slice(0, equal)
  if (!table.valued.has(name)) return { directory: null, consumed: 1 }
  return equal === -1
    ? { directory: directoryForOption(table, name, following), consumed: 2 }
    : { directory: directoryForOption(table, name, flag.slice(equal + 1)), consumed: 1 }
}

const takeOptions = ({ words, cwd: start }: ShellCall, path: Path.Path, table: OptionTable): ShellCall => {
  let cwd = start
  let index = 0
  while (index < words.length) {
    const flag = words[index]
    if (flag === "--") return { cwd, words: words.slice(index + 1) }
    if (typeof flag !== "string" || !flag.startsWith("-")) break
    const { directory, consumed } = optionAt(table, flag, words[index + 1])
    if (directory !== null) cwd = path.resolve(cwd, directory)
    index += consumed
  }
  return { cwd, words: words.slice(index) }
}

const scriptTarget = ({ words, cwd }: ShellCall, executableFallback: boolean): Target | null => {
  const [name] = words
  if (typeof name !== "string") return null
  if (isTestCall("bun", ["run", name])) return suite
  return { kind: "script", cwd, name, executableFallback }
}

const isTestCallOf = (manager: Manager, words: ShellCall["words"]): boolean =>
  isTestCall(manager, words.map((word) => word ?? ""))

const managerTarget = (manager: Manager, command: ShellCall, path: Path.Path): Target | null => {
  if (isTestCallOf(manager, command.words)) return suite
  const options = managerOptions[manager]
  const call = takeOptions(command, path, options)
  const [verb, ...words] = call.words
  const next = { cwd: call.cwd, words }
  if (verb === "run" || verb === "run-script") return scriptTarget(takeOptions(next, path, options), manager === "bun")
  if (verb === "exec" || verb === "x" || verb === "dlx") return testTargetOf(takeOptions(next, path, options), path)
  if (isTestCallOf(manager, call.words)) return suite
  if (typeof verb === "string" && installTestCommands[manager].has(verb)) return suite
  if (typeof verb !== "string" || !runsScriptByName[manager](verb)) return null
  return scriptTarget(call, manager === "bun")
}

const shellTarget = ({ cwd, words }: ShellCall): Target | null => {
  for (const [index, flag] of words.entries()) {
    if (typeof flag !== "string" || !flag.startsWith("-") || flag === "--") break
    if (!/^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) continue
    const command = words[index + 1]
    return typeof command === "string" ? { kind: "shell", cwd, command } : null
  }
  return null
}

const envTarget = (call: ShellCall, path: Path.Path, table: OptionTable): Target | null => {
  const { cwd, words } = takeOptions(call, path, table)
  const start = words.findIndex((word) => word === null || !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word))
  return start === -1 ? null : testTargetOf({ cwd, words: words.slice(start) }, path)
}

export const testTargetOf = ({ words, cwd }: ShellCall, path: Path.Path): Target | null => {
  const [program, ...args] = words
  if (typeof program !== "string") return null
  const tool = executableName(program)
  const call = { cwd, words: args }
  switch (tool) {
    case "bun":
    case "npm":
    case "pnpm":
    case "yarn":
      return managerTarget(tool, call, path)
    case "bunx":
    case "npx":
      return testTargetOf(takeOptions(call, path, runnerOptions), path)
    case "env":
      return envTarget(call, path, envOptions)
    case "cross-env":
      return envTarget(call, path, noOptionValues)
    case "command":
      return testTargetOf(takeOptions(call, path, noOptionValues), path)
    case "exec":
      return testTargetOf(takeOptions(call, path, execOptions), path)
    case "dotenv":
      return testTargetOf(takeOptions(call, path, dotenvOptions), path)
    case "sh":
    case "bash":
      return shellTarget(call)
    default:
      return isTestExecutable(program, args) ? suite : null
  }
}
