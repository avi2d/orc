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

const commandStart = (words: ReadonlyArray<string>, index: number): number => {
  const word = words[index] ?? ""
  if (assignmentWord.test(word)) {
    return commandStart(words, index + 1)
  }
  const operands = launcherOperands.get(word.slice(word.lastIndexOf("/") + 1))
  if (operands === undefined) {
    return index
  }
  const operand = words.findIndex((next, at) => at > index && !optionWord.test(next))
  return operand === -1 ? words.length : commandStart(words, operand + operands)
}

export const refusedPathCall = (command: string, cwd: string): boolean => {
  const words = command.trim().split(/\s+/).map((word) => word.replaceAll(/["'\\]/g, ""))
  const start = commandStart(words, 0)
  const tool = projectRunner.exec(words[start] ?? "")?.[1]
  return tool !== undefined && refusedTest(tool, words.slice(start + 1), cwd)
}
