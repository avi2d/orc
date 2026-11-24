import type { Path } from "effect"
import type { ShellCall } from "./shell-calls"

type Target =
  | { readonly kind: "suite" }
  | { readonly kind: "script"; readonly cwd: string; readonly name: string }
  | { readonly kind: "shell"; readonly cwd: string; readonly command: string }

const suite: Target = { kind: "suite" }

const leafName = (word: string): string => word.split(/[/\\]/).at(-1) ?? ""
const executableName = (word: string): string => leafName(word).replace(/@[^@]+$/, "").replace(/\.(?:exe|cmd|bat)$/, "")
const isE2eTarget = (word: string): boolean => /(^|[:_-])e2e(?:[:_.-]|$)/.test(leafName(word))
const isScriptTarget = (word: string): boolean => word === "test" || word.startsWith("test:") || isE2eTarget(word)

const startsRunner = (word: string): boolean => executableName(word) === "checks-test" || isE2eTarget(word)

const bunValueOptions = new Set([
  "--cwd", "--filter", "-F", "--elide-lines", "--env-file", "--config", "-c",
  "--preload", "-r", "--require", "--import", "--conditions", "--tsconfig-override",
  "--define", "-d", "--loader", "-l", "--package", "-p"
])

const takeOptions = (call: ShellCall, path: Path.Path): ShellCall => {
  const { words } = call
  let { cwd } = call
  let index = 0
  while (index < words.length) {
    const flag = words[index]
    if (flag === "--") {
      index += 1
      break
    }
    if (typeof flag !== "string" || !flag.startsWith("-")) break
    const equal = flag.indexOf("=")
    const name = equal === -1 ? flag : flag.slice(0, equal)
    if (bunValueOptions.has(name)) {
      if (equal === -1) index += 1
      const value = equal === -1 ? words[index] : flag.slice(equal + 1)
      if (name === "--cwd" && typeof value === "string") cwd = path.resolve(cwd, value)
    }
    index += 1
  }
  return { cwd, words: words.slice(index) }
}

const toolTarget = (word: string | null | undefined): Target | null =>
  typeof word === "string" && startsRunner(word) ? suite : null

const scriptTarget = (call: ShellCall): Target | null => {
  const [name] = call.words
  if (typeof name !== "string") return null
  if (isScriptTarget(name) || startsRunner(name)) return suite
  return { kind: "script", cwd: call.cwd, name }
}

export const testTargetOf = ({ words, cwd }: ShellCall, path: Path.Path): Target | null => {
  const [program, ...args] = words
  if (typeof program !== "string") return null
  if (startsRunner(program)) return suite
  switch (executableName(program)) {
    case "bun": {
      const call = takeOptions({ cwd, words: args }, path)
      const [verb, ...rest] = call.words
      if (verb === "test") return suite
      if (verb === "x") return toolTarget(takeOptions({ cwd: call.cwd, words: rest }, path).words[0])
      if (verb === "run") return scriptTarget(takeOptions({ cwd: call.cwd, words: rest }, path))
      return scriptTarget(call)
    }
    case "bunx":
    case "npx":
      return toolTarget(takeOptions({ cwd, words: args }, path).words[0])
    case "npm":
    case "pnpm":
    case "yarn": {
      const call = takeOptions({ cwd, words: args }, path)
      const [verb, ...rest] = call.words
      if (verb === "exec" || verb === "dlx") return toolTarget(takeOptions({ cwd: call.cwd, words: rest }, path).words[0])
      if (verb === "run" || verb === "run-script") return scriptTarget(takeOptions({ cwd: call.cwd, words: rest }, path))
      return scriptTarget(call)
    }
    case "env": {
      const start = args.findIndex((word) => word === null || !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word))
      return start === -1 ? null : testTargetOf(takeOptions({ cwd, words: args.slice(start) }, path), path)
    }
    case "command":
    case "exec":
      return testTargetOf({ cwd, words: args[0] === "--" ? args.slice(1) : args }, path)
    case "sh":
    case "bash": {
      const [flag, command] = args
      return flag === "-c" && typeof command === "string" ? { kind: "shell", cwd, command } : null
    }
    default:
      return null
  }
}
