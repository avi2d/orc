import { isTaskId } from "../entities/backlog/index"
import type { DispatchArgs } from "./dispatch-args-runner"

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

export const parseNote = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...words] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog note takes a task id, got \"" + id + "\"" }
  }
  const said = words.join(" ")
  return said.trim() === "" ? { kind: "UsageError", detail: "orc backlog note takes a task id and the note's words" } : { kind: "NoteTask", id, words: said }
}

const isItemId = (text: string): boolean => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(text)

export const parseItemAnswer = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...words] = rest
  if (!isItemId(id)) {
    return { kind: "UsageError", detail: "orc attention answer takes an item id, got \"" + id + "\"" }
  }
  const said = words.join(" ")
  return said.trim() === "" ? { kind: "UsageError", detail: "orc attention answer takes an item id and the answer's words" } : { kind: "AnswerItem", id, words: said }
}
