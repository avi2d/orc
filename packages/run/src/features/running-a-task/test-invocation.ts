import type { Path } from "effect"
import { isTestCall } from "../../entities/heavy-queue/index"
import type { ShellCall } from "./shell-calls"

type Manager = "bun" | "npm" | "pnpm" | "yarn"

type Target =
  | { readonly kind: "suite" }
  | { readonly kind: "script"; readonly cwd: string; readonly name: string; readonly executableFallback: boolean }
  | { readonly kind: "shell"; readonly cwd: string; readonly command: string }

const suite: Target = { kind: "suite" }

const leafName = (word: string): string => word.split(/[/\\]/).at(-1) ?? ""
const executableName = (word: string): string => leafName(word).replace(/@[^@]+$/, "").replace(/\.(?:exe|cmd|bat)$/, "")
const isE2eTarget = (word: string): boolean => /(^|[:_-])e2e(?:[:_.-]|$)/.test(leafName(word))

export const isTestExecutable = (program: string, args: ReadonlyArray<string | null> = []): boolean =>
  isTestCall(executableName(program), args.map((word) => word ?? "")) || isE2eTarget(program)

const directoryOptions = new Set(["--cwd", "-C", "--dir", "--prefix", "--chdir"])
const workspaceOptions = new Set(["--workspace", "-w"])
const valueOptions = new Set([
  ...directoryOptions, ...workspaceOptions,
  "--filter", "-F", "--elide-lines", "--env-file", "--config", "-c",
  "--preload", "-r", "--require", "--import", "--conditions", "--tsconfig-override",
  "--define", "-d", "--loader", "-l", "--package", "-p", "--unset", "-u"
])

const directoryForOption = (name: string, value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null
  if (directoryOptions.has(name) || (workspaceOptions.has(name) && /[./\\]/.test(value))) return value
  return null
}

const optionAt = (flag: string, following: string | null | undefined) => {
  const equal = flag.indexOf("=")
  const name = equal === -1 ? flag : flag.slice(0, equal)
  if (!valueOptions.has(name)) return { directory: null, consumed: 1 }
  return equal === -1
    ? { directory: directoryForOption(name, following), consumed: 2 }
    : { directory: directoryForOption(name, flag.slice(equal + 1)), consumed: 1 }
}

const takeOptions = ({ words, cwd: start }: ShellCall, path: Path.Path): ShellCall => {
  let cwd = start
  let index = 0
  while (index < words.length) {
    const flag = words[index]
    if (flag === "--") return { cwd, words: words.slice(index + 1) }
    if (typeof flag !== "string" || !flag.startsWith("-")) break
    const { directory, consumed } = optionAt(flag, words[index + 1])
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

const managerTarget = (manager: Manager, command: ShellCall, path: Path.Path): Target | null => {
  const call = takeOptions(command, path)
  const [verb, ...words] = call.words
  const next = { cwd: call.cwd, words }
  if (verb === "run" || verb === "run-script") return scriptTarget(takeOptions(next, path), manager === "bun")
  if (verb === "exec" || verb === "x" || verb === "dlx") return testTargetOf(takeOptions(next, path), path)
  if (isTestCall(manager, call.words.map((word) => word ?? ""))) return suite
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

const envTarget = (call: ShellCall, path: Path.Path): Target | null => {
  const { cwd, words } = takeOptions(call, path)
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
      return testTargetOf(takeOptions(call, path), path)
    case "env":
    case "cross-env":
      return envTarget(call, path)
    case "command":
    case "exec":
    case "dotenv":
      return testTargetOf(takeOptions(call, path), path)
    case "sh":
    case "bash":
      return shellTarget(call)
    default:
      return isTestExecutable(program, args) ? suite : null
  }
}
