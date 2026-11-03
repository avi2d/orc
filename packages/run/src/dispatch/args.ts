import { isTaskId } from "./backlog"
import { isEventKey } from "./events"
import { isCalendarDate } from "./task-record"
import { isTaskKind, type TaskKind, unknownKind } from "../task-kind"
import { isMergeBasis, type MergeBasis, mergeBases } from "./merge-basis"

export type TaskSource = { readonly kind: "file"; readonly path: string } | { readonly kind: "stdin" }

export type Reach = { readonly kind: "here" } | { readonly kind: "through"; readonly command: readonly [string, ...Array<string>] }

export type DispatchArgs =
  | { readonly kind: "ShowBacklog"; readonly json: boolean }
  | {
    readonly kind: "AddTask"
    readonly project: string
    readonly task: TaskSource
    readonly taskKind: TaskKind
    readonly internal: boolean
    readonly machine: string | null
    readonly dependsOn: ReadonlyArray<string>
  }
  | { readonly kind: "CloseTask"; readonly id: string; readonly outcome: "done" | "failed"; readonly reason: string }
  | { readonly kind: "MarkPosted"; readonly id: string }
  | { readonly kind: "MarkEventPosted"; readonly key: string }
  | { readonly kind: "HoldTask"; readonly id: string; readonly reason: string; readonly until: string | null }
  | { readonly kind: "AnswerTask"; readonly id: string; readonly words: string }
  | { readonly kind: "MergeTask"; readonly id: string; readonly basis: MergeBasis }
  | { readonly kind: "Beat"; readonly json: boolean }
  | { readonly kind: "RunnerStart"; readonly reach: Reach }
  | { readonly kind: "RunnerQueue" }
  | { readonly kind: "RunnerLoad" }
  | { readonly kind: "RunnerRenew"; readonly reach: Reach }
  | { readonly kind: "RunnerHold"; readonly task: string; readonly label?: string; readonly run: readonly [string, ...Array<string>] }
  | { readonly kind: "RunnerToken"; readonly session: string }
  | { readonly kind: "RunnerResult"; readonly task: string; readonly label?: string; readonly json: boolean; readonly reach: Reach; readonly stdinLabel: boolean }
  | { readonly kind: "UsageError"; readonly detail: string }

export const dispatchUsage =
  "orc backlog [--json] | orc backlog add <project> <task-file|-> [--kind <ship|scout|task>] [--internal] [--machine <name>] [--depends-on <task-id>] | orc backlog close <task-id> <done|failed> [reason] | orc backlog posted <task-id|event-key> | orc backlog hold <task-id> --reason <text> [--until <YYYY-MM-DD>] | orc backlog answer <task-id> <words|question-id=text> | orc merge <task-id> [--basis captain-word|yolo-green] | orc beat [--json] | orc runner start [-- <command that runs orc there>] | orc runner queue | orc runner renew [-- <command that runs orc there>] | orc runner hold <task-id> -- <run command> | orc runner token <clauth session-token.json> | orc runner result <task-id> [--json] [-- <command that runs orc there>] | orc runner load"

const parseJsonFlag = (rest: ReadonlyArray<string>, json: (json: boolean) => DispatchArgs): DispatchArgs => {
  if (rest.length === 0) {
    return json(false)
  }
  if (rest[0] !== "--json") {
    return { kind: "UsageError", detail: "unexpected argument: " + rest[0] }
  }
  return rest.length > 1 ? { kind: "UsageError", detail: "unexpected argument: " + rest[1] } : json(true)
}

const addFlags = ["--kind", "--machine", "--depends-on"] as const
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
  const values: Record<AddFlag, Array<string>> = { "--kind": [], "--machine": [], "--depends-on": [] }
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
  if (split.values["--machine"].length > 1) {
    return { kind: "UsageError", detail: "orc backlog add takes one --machine" }
  }
  const [machine = null] = split.values["--machine"]
  if (split.kept.length !== 2) {
    return { kind: "UsageError", detail: "orc backlog add takes a project and a task file" }
  }
  const [project = "", taskFile = ""] = split.kept
  const task: TaskSource = taskFile === "-" ? { kind: "stdin" } : { kind: "file", path: taskFile }
  return { kind: "AddTask", project, task, taskKind: taskKind.taskKind, internal: split.internal, machine, dependsOn: split.values["--depends-on"] }
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

type ReachSplit = { readonly kind: "split"; readonly words: ReadonlyArray<string>; readonly reach: Reach } | { readonly kind: "UsageError"; readonly detail: string }

const splitReach = (rest: ReadonlyArray<string>): ReachSplit => {
  const cut = rest.indexOf("--")
  if (cut === -1) {
    return { kind: "split", words: rest, reach: { kind: "here" } }
  }
  const [first = "", ...others] = rest.slice(cut + 1)
  if (first === "") {
    return { kind: "UsageError", detail: "orc runner takes a command after --" }
  }
  return { kind: "split", words: rest.slice(0, cut), reach: { kind: "through", command: [first, ...others] } }
}

const unexpected = (word: string | undefined): DispatchArgs => ({ kind: "UsageError", detail: "unexpected argument: " + (word ?? "") })

const parsePosted = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...extra] = rest
  if (extra.length > 0) {
    return unexpected(extra[0])
  }
  if (isEventKey(id)) {
    return { kind: "MarkEventPosted", key: id }
  }
  return isTaskId(id) ? { kind: "MarkPosted", id } : { kind: "UsageError", detail: "orc backlog posted takes a task id or an event key, got \"" + id + "\"" }
}

const takeHoldFlags = (words: ReadonlyArray<string>): { readonly reason: string | null; readonly until: string | null } | { readonly error: string } => {
  const values: { reason: string | null; until: string | null } = { reason: null, until: null }
  for (let index = 0; index < words.length; index += 2) {
    const flag = words[index] ?? ""
    if (flag !== "--reason" && flag !== "--until") {
      return { error: "unexpected argument: " + flag }
    }
    if (index + 1 >= words.length) {
      return { error: "orc backlog hold takes a value after " + flag }
    }
    const value = words[index + 1] ?? ""
    const key = flag === "--reason" ? "reason" : "until"
    if (values[key] !== null) {
      return { error: "orc backlog hold takes one " + flag }
    }
    values[key] = value
  }
  return values
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
  return { kind: "HoldTask", id, reason: taken.reason, until: taken.until }
}

const parseAnswer = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [id = "", ...words] = rest
  if (!isTaskId(id)) {
    return { kind: "UsageError", detail: "orc backlog answer takes a task id, got \"" + id + "\"" }
  }
  const said = words.join(" ")
  return said.trim() === "" ? { kind: "UsageError", detail: "orc backlog answer takes a task id and the captain's words" } : { kind: "AnswerTask", id, words: said }
}

const parseRunnerToken = (after: ReadonlyArray<string>): DispatchArgs => {
  const [session = "", ...extra] = after
  if (session === "" || session.startsWith("-")) {
    return { kind: "UsageError", detail: "orc runner token takes the path of a clauth session-token.json" }
  }
  return extra.length === 0 ? { kind: "RunnerToken", session } : unexpected(extra[0])
}

type StdinMarker = { readonly words: ReadonlyArray<string>; readonly stdinLabel: boolean } | { readonly error: string }

const stripStdinMarker = (verb: "hold" | "result", words: ReadonlyArray<string>): StdinMarker => {
  if (verb !== "result" || !words.includes("--stdin-label")) {
    return { words, stdinLabel: false }
  }
  const kept = words.filter((word) => word !== "--stdin-label")
  return kept.length === words.length - 1
    ? { words: kept, stdinLabel: true }
    : { error: "orc runner result takes one --stdin-label" }
}

type TaskLabel = { readonly label: string | undefined; readonly kept: Array<string> } | { readonly error: string }

const takeTaskLabel = (verb: "hold" | "result", words: ReadonlyArray<string>): TaskLabel => {
  let label: string | undefined
  const kept: Array<string> = []
  for (let index = 0; index < words.length; index += 1) {
    const flag = words[index] ?? ""
    if (flag !== "--label") {
      kept.push(flag)
      continue
    }
    const value = words[index + 1] ?? ""
    if (value === "" || value.startsWith("--")) {
      return { error: "orc runner " + verb + " takes a value after --label" }
    }
    if (label !== undefined) {
      return { error: "orc runner " + verb + " takes one --label" }
    }
    label = value
    index += 1
  }
  return { label, kept }
}

const parseRunnerTask = (verb: "hold" | "result", split: Extract<ReachSplit, { readonly kind: "split" }>): DispatchArgs => {
  const [task = "", ...flags] = split.words
  if (!isTaskId(task)) {
    return { kind: "UsageError", detail: "orc runner " + verb + " takes a task id, got \"" + task + "\"" }
  }
  const marked = stripStdinMarker(verb, flags)
  if ("error" in marked) {
    return { kind: "UsageError", detail: marked.error }
  }
  const taken = takeTaskLabel(verb, marked.words)
  if ("error" in taken) {
    return { kind: "UsageError", detail: taken.error }
  }
  if (verb === "result") {
    return parseJsonFlag(taken.kept, (json) => ({ kind: "RunnerResult", task, ...(taken.label === undefined ? {} : { label: taken.label }), json, reach: split.reach, stdinLabel: marked.stdinLabel }))
  }
  if (split.reach.kind === "here" || taken.kept.length > 0) {
    return { kind: "UsageError", detail: "orc runner hold takes a task id, then -- and the run command" }
  }
  return { kind: "RunnerHold", task, ...(taken.label === undefined ? {} : { label: taken.label }), run: split.reach.command }
}

const parseRunner = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [verb = "", ...after] = rest
  if (verb === "queue") {
    return after.length === 0 ? { kind: "RunnerQueue" } : unexpected(after[0])
  }
  if (verb === "load") {
    return after.length === 0 ? { kind: "RunnerLoad" } : unexpected(after[0])
  }
  if (verb === "token") {
    return parseRunnerToken(after)
  }
  if (verb !== "start" && verb !== "renew" && verb !== "hold" && verb !== "result") {
    return { kind: "UsageError", detail: "orc runner takes start, queue, renew, hold, token, result or load" }
  }
  const split = splitReach(after)
  if (split.kind === "UsageError") {
    return split
  }
  if (verb === "hold" || verb === "result") {
    return parseRunnerTask(verb, split)
  }
  if (split.words.length > 0) {
    return unexpected(split.words[0])
  }
  return { kind: verb === "start" ? "RunnerStart" : "RunnerRenew", reach: split.reach }
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

export const parseDispatchArgs = (command: "backlog" | "beat" | "runner" | "merge", rest: ReadonlyArray<string>): DispatchArgs => {
  if (command === "runner") {
    return parseRunner(rest)
  }
  if (command === "merge") {
    return parseMerge(rest)
  }
  if (command === "beat") {
    return parseJsonFlag(rest, (json) => ({ kind: "Beat", json }))
  }
  if (rest[0] === "add") {
    return parseAdd(rest.slice(1))
  }
  if (rest[0] === "close") {
    return parseClose(rest.slice(1))
  }
  if (rest[0] === "posted") {
    return parsePosted(rest.slice(1))
  }
  if (rest[0] === "hold") {
    return parseHold(rest.slice(1))
  }
  if (rest[0] === "answer") {
    return parseAnswer(rest.slice(1))
  }
  return parseJsonFlag(rest, (json) => ({ kind: "ShowBacklog", json }))
}
