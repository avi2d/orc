import { isCalendarDate, isTaskId } from "../entities/backlog/index"
import type { DispatchArgs } from "./dispatch-args-runner"

interface HoldFlags {
  readonly reason: string | null
  readonly until: string | null
  readonly questions: ReadonlyArray<string>
}

const takeHoldFlags = (words: ReadonlyArray<string>): HoldFlags | { readonly error: string } => {
  const values: { reason: string | null; until: string | null } = { reason: null, until: null }
  const questions: Array<string> = []
  for (let index = 0; index < words.length; index += 2) {
    const flag = words[index] ?? ""
    if (flag !== "--reason" && flag !== "--until" && flag !== "--question") {
      return { error: "unexpected argument: " + flag }
    }
    if (index + 1 >= words.length) {
      return { error: "orc backlog hold takes a value after " + flag }
    }
    const value = words[index + 1] ?? ""
    if (flag === "--question") {
      if (value.trim() === "") {
        return { error: "orc backlog hold takes the question's text after --question" }
      }
      questions.push(value)
      continue
    }
    const key = flag === "--reason" ? "reason" : "until"
    if (values[key] !== null) {
      return { error: "orc backlog hold takes one " + flag }
    }
    values[key] = value
  }
  return { ...values, questions }
}

export const parseHold = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...flags] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog hold takes a task id, got \"" + id + "\"" }
  }
  const taken = takeHoldFlags(flags)
  if ("error" in taken) {
    return { kind: "UsageError", detail: taken.error }
  }
  if (taken.reason === null || taken.reason.trim() === "") {
    return { kind: "UsageError", detail: "orc backlog hold takes --reason and why the task waits for the captain" }
  }
  if (taken.until !== null && !isCalendarDate(taken.until)) {
    return { kind: "UsageError", detail: "orc backlog hold takes a YYYY-MM-DD date after --until, got \"" + taken.until + "\"" }
  }
  return { kind: "HoldTask", id, reason: taken.reason, until: taken.until, questions: taken.questions }
}

type AnswerOptions = { readonly expect: "held" | "parked" | undefined; readonly generation: string | undefined; readonly cursor: ReadonlyArray<string> }

const checkExpectFlag = (value: string): { readonly expect: "held" | "parked" } | { readonly detail: string } =>
  value === "held" || value === "parked" ? { expect: value } : { detail: "orc backlog answer takes held or parked after --expect, got \"" + value + "\"" }

const checkGenerationFlag = (value: string): { readonly generation: string } | { readonly detail: string } =>
  /^\d+$/.test(value) ? { generation: value } : { detail: "orc backlog answer takes a hold generation after --generation, got \"" + value + "\"" }

const takeAnswerOptions = (after: ReadonlyArray<string>): AnswerOptions | { readonly detail: string } => {
  let expect: "held" | "parked" | undefined
  let generation: string | undefined
  let cursor = after
  while (cursor[0] === "--expect" || cursor[0] === "--generation") {
    const flag = cursor[0]
    const value = cursor.at(1)
    if (value === undefined) {
      return { detail: "orc backlog answer takes a decision kind after --expect and a hold generation after --generation" }
    }
    if (flag === "--expect") {
      const checked = checkExpectFlag(value)
      if ("detail" in checked) {
        return checked
      }
      expect = checked.expect
    } else {
      const checked = checkGenerationFlag(value)
      if ("detail" in checked) {
        return checked
      }
      generation = checked.generation
    }
    cursor = cursor.slice(2)
  }
  return { expect, generation, cursor }
}

const finishAnswer = (id: string, options: AnswerOptions): DispatchArgs => {
  if (options.expect === "held" && options.generation === undefined) {
    return { kind: "UsageError", detail: "orc backlog answer takes a hold generation after --generation for a held decision" }
  }
  if (options.expect === "parked" && options.generation !== undefined) {
    return { kind: "UsageError", detail: "orc backlog answer takes no hold generation for a parked decision" }
  }
  const said = options.cursor.join(" ")
  if (said.trim() === "") {
    return { kind: "UsageError", detail: "orc backlog answer takes a task id and the captain's words" }
  }
  return options.expect === undefined && options.generation === undefined
    ? { kind: "AnswerTask", id, words: said }
    : { kind: "AnswerTask", id, words: said, expect: options.expect === "parked" ? { kind: "parked" } : { kind: "held", generation: Number(options.generation) } }
}

export const parseAnswer = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...after] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog answer takes a task id, got \"" + id + "\"" }
  }
  const options = takeAnswerOptions(after)
  return "detail" in options ? { kind: "UsageError", detail: options.detail } : finishAnswer(id, options)
}
