import { type Guard, type Guarded, type ShownStep, arrayOf, fields, guardJson, number, ok, refused, string } from "./guard"

interface FailedTest {
  readonly name: string
  readonly error: ReadonlyArray<string>
}

export type CheckFailure =
  | { readonly kind: "tests"; readonly failed: ReadonlyArray<FailedTest>; readonly passCount: number | null; readonly failCount: number | null }
  | { readonly kind: "tail"; readonly lines: ReadonlyArray<string> }

type CheckOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "interrupted"; readonly failure: CheckFailure }
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly failure: CheckFailure }

export interface CheckSummary {
  readonly name: string
  readonly seconds: number | null
  readonly outcome: CheckOutcome
}

export type ChecksSummary = ReadonlyArray<CheckSummary> | null

const escapeSequence = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g")

export const logLines = (text: string): ReadonlyArray<string> =>
  text.replace(escapeSequence, "").replace(/\n$/, "").split("\n")

const tailLines = 20
const testLine = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/
const testFile = /^\S.*\.(test|spec)\.[cm]?[jt]sx?:$/
const bunRunner = /^bun test v\d+/
const bunFailedRecap = /^\d+ tests? failed:$/

const trimBlank = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const start = lines.findIndex((line) => line.trim() !== "")
  const end = lines.length - [...lines].reverse().findIndex((line) => line.trim() !== "")
  return start === -1 ? [] : lines.slice(start, end)
}

const lastCount = (lines: ReadonlyArray<string>, word: string): number | null => {
  const pattern = new RegExp(`^\\s*(\\d+) ${word}$`)
  const found = [...lines].reverse().find((line) => pattern.test(line))
  return found === undefined ? null : Number(pattern.exec(found)?.[1])
}

const failedTests = (output: ReadonlyArray<string>): ReadonlyArray<FailedTest> => {
  const runner = output.findIndex((line) => bunRunner.test(line))
  if (runner === -1) return []
  const failed: Array<FailedTest> = []
  let since: Array<string> = []
  for (const line of output.slice(runner + 1)) {
    if (failed.length > 0 && bunFailedRecap.test(line)) break
    const result = testLine.exec(line)
    if (result === null && !testFile.test(line)) {
      since.push(line)
      continue
    }
    const name = result?.at(2)
    if (result?.[1] === "fail" && name !== undefined) {
      const error = since.findIndex((said) => said.startsWith("error"))
      failed.push({ name, error: trimBlank(error === -1 ? since : since.slice(error)) })
    }
    since = []
  }
  return failed
}

const failureOf = (output: ReadonlyArray<string>): CheckFailure => {
  const failed = failedTests(output)
  return failed.length > 0
    ? { kind: "tests", failed, passCount: lastCount(output, "pass"), failCount: lastCount(output, "fail") }
    : { kind: "tail", lines: trimBlank(output).slice(-tailLines) }
}

const unfinished = (name: string, stepStatus: ShownStep["status"], output: ReadonlyArray<string>): CheckSummary => ({
  name,
  seconds: null,
  outcome: stepStatus === "running" ? { kind: "running" } : { kind: "interrupted", failure: failureOf(output) }
})

interface CheckBoundary {
  readonly name: string
  readonly outputStart: number
  readonly result: { readonly outputEnd: number; readonly passed: boolean; readonly seconds: number } | null
}

const checkBoundary: Guard<CheckBoundary> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const name = string(record.value, "name", at)
  if (name.kind === "refused") return name
  const start = record.value["outputStart"]
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
    return refused(`${at}.outputStart`, "a nonnegative integer", start)
  }
  const boundary = { name: name.value, outputStart: start }
  if (record.value["result"] === null) return ok({ ...boundary, result: null })
  const resultAt = `${at}.result`
  const result = fields(record.value["result"], resultAt)
  if (result.kind === "refused") return result
  const end = result.value["outputEnd"]
  if (typeof end !== "number" || !Number.isSafeInteger(end) || end < start) {
    return refused(`${resultAt}.outputEnd`, "an integer at or after outputStart", end)
  }
  const passed = result.value["passed"]
  if (typeof passed !== "boolean") return refused(`${resultAt}.passed`, "a boolean", passed)
  const seconds = number(result.value, "seconds", resultAt)
  if (seconds.kind === "refused") return seconds
  if (seconds.value < 0) return refused(`${resultAt}.seconds`, "a nonnegative number", seconds.value)
  return ok({ ...boundary, result: { outputEnd: end, passed, seconds: seconds.value } })
}

export const parseCheckIndex = (text: string): Guarded<ReadonlyArray<CheckBoundary>> =>
  guardJson(text, (value, at) => {
    const index = fields(value, at)
    return index.kind === "ok" ? arrayOf(index.value, "checks", at, checkBoundary) : index
  })

export const checkIndexFile = (taskFile: string, step: Pick<ShownStep, "attempt" | "from">): string => {
  const runDir = taskFile.slice(0, taskFile.lastIndexOf("/"))
  const dir = step.from === null ? runDir : runDir.slice(0, runDir.lastIndexOf("/")) + "/" + step.from
  return `${dir}/session/checks-${step.attempt.toString()}.txt.index.json`
}

const indexedSummary = (text: string, stepStatus: ShownStep["status"], entry: CheckBoundary): CheckSummary => {
  const { name, result, outputStart } = entry
  if (result === null) return unfinished(name, stepStatus, logLines(text.slice(outputStart)))
  return {
    name,
    seconds: result.seconds,
    outcome: result.passed
      ? { kind: "passed" }
      : { kind: "failed", failure: failureOf(logLines(text.slice(outputStart, result.outputEnd))) }
  }
}

export const checksSummary = (
  text: string,
  stepStatus: ShownStep["status"],
  index: ReadonlyArray<CheckBoundary> | null
): ChecksSummary => index === null ? null : index.map((entry) => indexedSummary(text, stepStatus, entry))

export const checkTime = (seconds: number | null): string => {
  if (seconds === null) return ""
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60).toString()}m ${(whole % 60).toString().padStart(2, "0")}s`
}
