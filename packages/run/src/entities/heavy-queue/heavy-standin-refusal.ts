import { isTestCall } from "./heavy-classify"
import { bunRuntimeOverride, interpretedRunner } from "./heavy-runner-entry"

const testsCiOnlyVariable = "HEAVY_TESTS_CI_ONLY"

const testRefusal = (command: string, runner: string | null): string =>
  "orc heavy: " + command + " starts a test run" + (runner === null ? "" : " through " + runner) + ", and with " + testsCiOnlyVariable +
  "=1 the repository tests run only in GitHub CI"

const testsCiOnly = (): boolean => Bun.env[testsCiOnlyVariable] === "1"

export const refusedTest = (tool: string, args: ReadonlyArray<string>, cwd: string): boolean => {
  if (!testsCiOnly()) {
    return false
  }
  const command = [tool, ...args].join(" ")
  const override = bunRuntimeOverride(tool, args, cwd)
  if (override !== null) {
    process.stderr.write(
      "orc heavy: refusing " + command + " because " + override + " can bypass CI-only runtime stand-ins; repository tests run only in GitHub CI\n"
    )
    return true
  }
  if (isTestCall(tool, args)) {
    process.stderr.write(testRefusal(command, null) + "\n")
    return true
  }
  const runner = interpretedRunner(tool, args, cwd)
  if (runner === null) {
    return false
  }
  process.stderr.write(testRefusal(command, runner) + "\n")
  return true
}

const assignmentWord = /^[A-Za-z_][A-Za-z0-9_]*=/
const optionWord = /^-/
const launcherOperands: ReadonlyMap<string, number> = new Map([
  ["exec", 0], ["command", 0], ["env", 0], ["nice", 0], ["nohup", 0], ["timeout", 1], ["sh", 0], ["bash", 0]
])
const projectRunner = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/

const shellWords = (command: string): Array<string> =>
  (command.match(/(?:[^\s;&|"'\\]+|\\.|'[^']*'|"[^"]*")+|&&|\|\||[;|&]/g) ?? [])
    .map((word) => word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_match, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
      single ?? double ?? escaped ?? ""))

const launcherStart = (words: ReadonlyArray<string>, index: number, launcher: string): number => {
  let next = index + 1
  while (optionWord.test(words[next] ?? "")) {
    const option = words[next++]
    if (option === "--") {
      break
    }
    if (launcher === "command" && (option === "-v" || option === "-V")) {
      return words.length
    }
    if (launcher === "nice" && (option === "-n" || option === "--adjustment")) {
      next++
    }
  }
  return next + (launcherOperands.get(launcher) ?? 0)
}

const refusedWords = (words: ReadonlyArray<string>, index: number, cwd: string): boolean => {
  const word = words[index] ?? ""
  if (assignmentWord.test(word)) {
    return refusedWords(words, index + 1, cwd)
  }
  const name = word.slice(word.lastIndexOf("/") + 1)
  if ((name === "sh" || name === "bash") && words[index + 1] === "-c") {
    return refusedPathCall(words[index + 2] ?? "", cwd)
  }
  if (launcherOperands.has(name)) {
    const next = launcherStart(words, index, name)
    return next < words.length && refusedWords(words, next, cwd)
  }
  const tool = projectRunner.exec(word)?.[1]
  return tool !== undefined && refusedTest(tool, words.slice(index + 1), cwd)
}

export const refusedPathCall = (command: string, cwd: string): boolean => {
  const words = shellWords(command)
  const separator = /^(?:&&|\|\||[;|&])$/
  let start = 0
  for (let index = 0; index <= words.length; index++) {
    if (index === words.length || separator.test(words[index] ?? "")) {
      if (refusedWords(words.slice(start, index), 0, cwd)) {
        return true
      }
      start = index + 1
    }
  }
  return false
}
