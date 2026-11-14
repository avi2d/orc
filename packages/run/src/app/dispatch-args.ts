import { isTaskId, isCalendarDate, isTaskKind, isTaskPriority, type TaskKind, type TaskPriority, unknownKind } from "../entities/backlog/index"
import { parseJsonFlag, parseRunner, unexpected, type DispatchArgs as RunnerArgs } from "./dispatch-args-runner"
import type { EditTask, TaskSource } from "../features/backlog-planning/index"

export type DispatchArgs = RunnerArgs | EditTask
import { isEventKey } from "../entities/events/index"
import { isMergeBasis, mergeBases } from "../entities/pull-request/index"

export const dispatchUsage =
  "orc backlog [--json] | orc attention [--json] | orc attention answer <item-id> <words> | orc backlog add <project> <task-file|-> [--kind <ship|scout|task|parent>] [--internal] [--machine <name>] [--parent <task-id>] [--depends-on <task-id>] [--priority <0-4>] | orc backlog priority <task-id> <0-4|none> | orc backlog edit <task-id> <task-file|-> | orc backlog close <task-id> <done|failed> [reason] | orc backlog stop <task-id> | orc backlog posted <task-id|event-key> | orc backlog hold <task-id> --reason <text> [--until <YYYY-MM-DD>] [--question <text>] | orc backlog answer <task-id> <words|question-id=text> | orc backlog note <task-id> <words> | orc backlog depend <task-id> --on <task-id>[,<task-id>...] | orc backlog depend <task-id> --clear | orc backlog plan <task-id> [--drop <task-id>] | orc merge <task-id> [--basis captain-word|yolo-green] | orc beat [--json] | orc runner start [-- <command that runs orc there>] | orc runner queue | orc runner renew [-- <command that runs orc there>] | orc runner hold <task-id> -- <run command> | orc runner token <claude-credentials.json> | orc runner result <task-id> [--json] [-- <command that runs orc there>] | orc runner kill <task-id> | orc runner answer <task-id> | orc runner load | orc heavy path | orc heavy check [--json] | orc heavy watch | orc heavy watch-once"

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

const priorityOf = (word: string): TaskPriority | null => {
  const value = /^\d$/.test(word) ? Number(word) : -1
  return isTaskPriority(value) ? value : null
}

const addPriority = (words: ReadonlyArray<string>): { readonly kind: "priority"; readonly priority: TaskPriority | null } | { readonly kind: "refused"; readonly detail: string } => {
  if (words.length > 1) {
    return { kind: "refused", detail: "orc backlog add takes one --priority" }
  }
  const [word] = words
  if (word === undefined) {
    return { kind: "priority", priority: null }
  }
  const priority = priorityOf(word)
  return priority === null ? { kind: "refused", detail: "orc backlog add takes 0 to 4 after --priority, got \"" + word + "\"" } : { kind: "priority", priority }
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

const parsePriority = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", word = "", ...extra] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog priority takes a task id, got \"" + id + "\"" }
  }
  if (extra.length > 0) {
    return unexpected(extra[0])
  }
  if (word === "none") {
    return { kind: "PrioritizeTask", id, priority: null }
  }
  const priority = priorityOf(word)
  return priority === null
    ? { kind: "UsageError", detail: "orc backlog priority takes 0 to 4 or none, got \"" + word + "\"" }
    : { kind: "PrioritizeTask", id, priority }
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

const parseAnswer = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...after] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog answer takes a task id, got \"" + id + "\"" }
  }
  const options = takeAnswerOptions(after)
  return "detail" in options ? { kind: "UsageError", detail: options.detail } : finishAnswer(id, options)
}

const parseNote = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...words] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog note takes a task id, got \"" + id + "\"" }
  }
  const said = words.join(" ")
  return said.trim() === "" ? { kind: "UsageError", detail: "orc backlog note takes a task id and the note's words" } : { kind: "NoteTask", id, words: said }
}

const isItemId = (text: string): boolean => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(text)

const parseItemAnswer = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...words] = rest
  if (!isItemId(id)) {
    return { kind: "UsageError", detail: "orc attention answer takes an item id, got \"" + id + "\"" }
  }
  const said = words.join(" ")
  return said.trim() === "" ? { kind: "UsageError", detail: "orc attention answer takes an item id and the answer's words" } : { kind: "AnswerItem", id, words: said }
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

const parseHeavy = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [verb = "", ...extra] = rest
  if (verb === "path") {
    return extra.length === 0 ? { kind: "HeavyPath" } : unexpected(extra[0])
  }
  if (verb === "check") {
    return parseJsonFlag(extra, (json) => ({ kind: "HeavyCheck", json }))
  }
  if (verb === "watch") {
    return extra.length === 0 ? { kind: "HeavyWatch" } : unexpected(extra[0])
  }
  if (verb === "watch-once") {
    return extra.length === 0 ? { kind: "HeavyWatchOnce" } : unexpected(extra[0])
  }
  return { kind: "UsageError", detail: "orc heavy takes path, check [--json], watch or watch-once, got \"" + verb + "\"" }
}

const backlogSubcommands: ReadonlyMap<string, (rest: ReadonlyArray<string>) => DispatchArgs> = new Map([
  ["add", parseAdd],
  ["edit", parseEdit],
  ["close", parseClose],
  ["stop", parseStop],
  ["posted", parsePosted],
  ["hold", parseHold],
  ["answer", parseAnswer],
  ["note", parseNote],
  ["depend", parseDepend],
  ["plan", parsePlan],
  ["priority", parsePriority],
])

export const parseDispatchArgs = (command: "backlog" | "attention" | "beat" | "runner" | "merge" | "heavy", rest: ReadonlyArray<string>): DispatchArgs => {
  if (command === "attention") {
    return rest[0] === "answer" ? parseItemAnswer(rest.slice(1)) : parseJsonFlag(rest, (json) => ({ kind: "ShowAttention", json }))
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
  const parseSubcommand = backlogSubcommands.get(rest[0] ?? "")
  if (parseSubcommand !== undefined) {
    return parseSubcommand(rest.slice(1))
  }
  return parseJsonFlag(rest, (json) => ({ kind: "ShowBacklog", json }))
}
