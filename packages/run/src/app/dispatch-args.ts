import { isTaskId, isCalendarDate, isTaskKind, type TaskKind, unknownKind } from "../entities/backlog/index"
import { parseJsonFlag, parseRunner, unexpected, type DispatchArgs as RunnerArgs } from "./dispatch-args-runner"
import { parseHeavy } from "./dispatch-args-heavy"
export type { HeavyWord } from "./dispatch-args-heavy"
import { parseAnswer, parseItemAnswer, parseNote } from "./dispatch-args-answer"
import { addPriority, parsePriority } from "./dispatch-args-priority"
import type { DropTask, EditTask, TaskSource } from "../features/backlog-planning/index"
import type { RecordOrigin } from "../widgets/beat/index"

export type DispatchArgs = RunnerArgs | EditTask | DropTask | RecordOrigin
import { isEventKey } from "../entities/events/index"
import { isMergeBasis, mergeBases } from "../entities/pull-request/index"

const addFlags = ["--kind", "--machine", "--parent", "--depends-on", "--priority"] as const
type AddFlag = typeof addFlags[number]

const isAddFlag = (token: string): token is AddFlag => addFlags.some((flag) => flag === token)

type AddWords =
  | {
    readonly kind: "words"
    readonly kept: ReadonlyArray<string>
    readonly values: Readonly<Record<AddFlag, ReadonlyArray<string>>>
    readonly internal: boolean
  }
  | { readonly kind: "missing"; readonly flag: AddFlag }

const splitAdd = (rest: ReadonlyArray<string>): AddWords => {
  const kept: Array<string> = []
  const values: Record<AddFlag, Array<string>> = { "--kind": [], "--machine": [], "--parent": [], "--depends-on": [], "--priority": [] }
  let internal = false
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ""
    if (token === "--internal") {
      internal = true
      continue
    }
    if (!isAddFlag(token)) {
      kept.push(token)
      continue
    }
    const value = rest[index + 1] ?? ""
    if (value === "" || value.startsWith("--")) {
      return { kind: "missing", flag: token }
    }
    values[token].push(value)
    index += 1
  }
  return { kind: "words", kept, values, internal }
}

const addTaskKind = (words: ReadonlyArray<string>): { readonly kind: "kind"; readonly taskKind: TaskKind } | { readonly kind: "refused"; readonly detail: string } => {
  if (words.length > 1) {
    return { kind: "refused", detail: "orc backlog add takes one --kind" }
  }
  const [word = "ship"] = words
  return isTaskKind(word) ? { kind: "kind", taskKind: word } : { kind: "refused", detail: unknownKind(word) }
}

const parseAdd = (rest: ReadonlyArray<string>): DispatchArgs => {
  const split = splitAdd(rest)
  if (split.kind === "missing") {
    return { kind: "UsageError", detail: "orc backlog add takes a value after " + split.flag }
  }
  const taskKind = addTaskKind(split.values["--kind"])
  if (taskKind.kind === "refused") {
    return { kind: "UsageError", detail: taskKind.detail }
  }
  if (split.internal && taskKind.taskKind !== "ship") {
    return { kind: "UsageError", detail: "orc backlog add takes --internal only for a ship task" }
  }
  const priority = addPriority(split.values["--priority"])
  if (priority.kind === "refused") {
    return { kind: "UsageError", detail: priority.detail }
  }
  if (split.values["--machine"].length > 1) {
    return { kind: "UsageError", detail: "orc backlog add takes one --machine" }
  }
  const [machine = null] = split.values["--machine"]
  const [parent = null, ...moreParents] = split.values["--parent"]
  if (moreParents.length > 0) {
    return { kind: "UsageError", detail: "orc backlog add takes one --parent" }
  }
  if (parent !== null && !isTaskId(parent)) {
    return { kind: "UsageError", detail: "orc backlog add takes a task id after --parent, got \"" + parent + "\"" }
  }
  if (parent !== null && taskKind.taskKind === "parent") {
    return { kind: "UsageError", detail: "orc backlog add takes --parent only for a child, and a parent task has no parent" }
  }
  if (split.kept.length !== 2) {
    return { kind: "UsageError", detail: "orc backlog add takes a project and a task file" }
  }
  const [project = "", taskFile = ""] = split.kept
  const task: TaskSource = taskFile === "-" ? { kind: "stdin" } : { kind: "file", path: taskFile }
  return { kind: "AddTask", project, task, taskKind: taskKind.taskKind, internal: split.internal, machine, parent, dependsOn: split.values["--depends-on"], priority: priority.priority }
}

const parseEdit = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", taskFile = "", ...extra] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog edit takes a task id, got \"" + id + "\"" }
  }
  if (taskFile === "") {
    return { kind: "UsageError", detail: "orc backlog edit takes a task id and a task file" }
  }
  return extra.length === 0 ? { kind: "EditTask", id, task: taskFile === "-" ? { kind: "stdin" } : { kind: "file", path: taskFile } } : unexpected(extra[0])
}

const parseOrigin = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", machine = "", run = "", ...extra] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog origin takes a task id, got \"" + id + "\"" }
  }
  if (machine === "" || run === "") {
    return { kind: "UsageError", detail: "orc backlog origin takes a task id, a machine and a run id" }
  }
  return extra.length === 0 ? { kind: "RecordOrigin", id, machine, run } : unexpected(extra[0])
}

const parseStop = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...extra] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog stop takes a task id, got \"" + id + "\"" }
  }
  return extra.length === 0 ? { kind: "StopTask", id } : unexpected(extra[0])
}

const parseClose = (rest: ReadonlyArray<string>): DispatchArgs => {
  if (rest.length < 2 || rest.length > 3) {
    return { kind: "UsageError", detail: "orc backlog close takes a task id, done or failed, and an optional reason" }
  }
  const [id = "", outcome = "", reason = ""] = rest
  if (outcome !== "done" && outcome !== "failed") {
    return { kind: "UsageError", detail: "orc backlog close takes done or failed, got \"" + outcome + "\"" }
  }
  return { kind: "CloseTask", id, outcome, reason }
}

const parseDrop = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...words] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog drop takes a task id, got \"" + id + "\"" }
  }
  const reason = words.join(" ")
  return reason.trim() === "" ? { kind: "UsageError", detail: "orc backlog drop takes a task id and the reason it is dropped" } : { kind: "DropTask", id, reason }
}

const parsePosted = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...extra] = rest
  if (extra.length > 0) {
    return unexpected(extra[0])
  }
  // A project name may hold a dot, so acme.io-1 also reads as an event key, and no event key ends in -<digits>.
  if (isTaskId(id)) {
    return { kind: "MarkPosted", id }
  }
  return isEventKey(id) ? { kind: "MarkEventPosted", key: id } : { kind: "UsageError", detail: "orc backlog posted takes a task id or an event key, got \"" + id + "\"" }
}

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

const parseHold = (rest: ReadonlyArray<string>): DispatchArgs => {
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

const parseThread = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...flags] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog thread takes a task id, got \"" + id + "\"" }
  }
  return parseJsonFlag(flags, (json) => ({ kind: "ShowThread", id, json }))
}

const parseDepend = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", flag = "", ...after] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog depend takes a task id, got \"" + id + "\"" }
  }
  if (flag === "--clear") {
    return after.length === 0 ? { kind: "DependTask", id, dependsOn: [] } : unexpected(after[0])
  }
  if (flag !== "--on") {
    return { kind: "UsageError", detail: "orc backlog depend takes --on and the task ids it waits for, or --clear" }
  }
  const [list = "", ...extra] = after
  if (extra.length > 0) {
    return unexpected(extra[0])
  }
  const named = list.split(",").map((entry) => entry.trim())
  const unnamed = named.find((entry) => !isTaskId(entry))
  if (unnamed !== undefined) {
    return { kind: "UsageError", detail: "orc backlog depend takes comma separated task ids after --on, got \"" + unnamed + "\"" }
  }
  return { kind: "DependTask", id, dependsOn: [...new Set(named)] }
}

const parsePlan = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [parent = "", flag = "", child = "", ...extra] = rest
  if (!isTaskId(parent)) {
    return { kind: "UsageError", detail: "orc backlog plan takes a parent task id, got \"" + parent + "\"" }
  }
  if (rest.length === 1) {
    return { kind: "ShowPlan", parent }
  }
  if (flag !== "--drop") {
    return unexpected(flag)
  }
  if (!isTaskId(child)) {
    return { kind: "UsageError", detail: "orc backlog plan takes a child task id after --drop, got \"" + child + "\"" }
  }
  return extra.length === 0 ? { kind: "DropChild", parent, child } : unexpected(extra[0])
}

const parseMerge = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...flags] = rest
  if (id === "") {
    return { kind: "UsageError", detail: "orc merge takes a task id" }
  }
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc merge takes a task id, got \"" + id + "\"" }
  }
  if (flags.length === 0) {
    return { kind: "MergeTask", id, basis: "captain-word" }
  }
  const [flag, basis = "", ...extra] = flags
  if (flag !== "--basis" || !isMergeBasis(basis)) {
    return { kind: "UsageError", detail: "orc merge takes --basis once, with " + mergeBases.join(" or ") }
  }
  return extra.length === 0 ? { kind: "MergeTask", id, basis } : unexpected(extra[0])
}

const attentionSubcommands = {
  answer: parseItemAnswer
} satisfies Record<string, (rest: ReadonlyArray<string>) => DispatchArgs>

export type AttentionWord = keyof typeof attentionSubcommands
const isAttentionWord = (word: string): word is AttentionWord => Object.hasOwn(attentionSubcommands, word)

const backlogSubcommands = {
  add: parseAdd,
  edit: parseEdit,
  origin: parseOrigin,
  close: parseClose,
  stop: parseStop,
  drop: parseDrop,
  posted: parsePosted,
  hold: parseHold,
  answer: parseAnswer,
  note: parseNote,
  thread: parseThread,
  depend: parseDepend,
  plan: parsePlan,
  priority: parsePriority
} satisfies Record<string, (rest: ReadonlyArray<string>) => DispatchArgs>

export type BacklogVerb = keyof typeof backlogSubcommands
const isBacklogVerb = (word: string): word is BacklogVerb => Object.hasOwn(backlogSubcommands, word)

export const parseDispatchArgs = (command: "backlog" | "attention" | "beat" | "runner" | "merge" | "heavy", rest: ReadonlyArray<string>): DispatchArgs => {
  if (command === "attention") {
    const [verb = ""] = rest
    return isAttentionWord(verb) ? attentionSubcommands[verb](rest.slice(1)) : parseJsonFlag(rest, (json) => ({ kind: "ShowAttention", json }))
  }
  if (command === "heavy") {
    return parseHeavy(rest)
  }
  if (command === "runner") {
    return parseRunner(rest)
  }
  if (command === "merge") {
    return parseMerge(rest)
  }
  if (command === "beat") {
    return parseJsonFlag(rest, (json) => ({ kind: "Beat", json }))
  }
  const [verb = ""] = rest
  if (isBacklogVerb(verb)) {
    return backlogSubcommands[verb](rest.slice(1))
  }
  return parseJsonFlag(rest, (json) => ({ kind: "ShowBacklog", json }))
}
