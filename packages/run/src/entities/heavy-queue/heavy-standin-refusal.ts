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
