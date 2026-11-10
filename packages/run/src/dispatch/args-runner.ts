import { isTaskId } from "./backlog"
import type { MergeBasis } from "./merge-basis"
import type { TaskKind } from "../task-kind"

export type TaskSource = { readonly kind: "file"; readonly path: string } | { readonly kind: "stdin" }

export type Reach = { readonly kind: "here" } | { readonly kind: "through"; readonly command: readonly [string, ...Array<string>] }

export type DispatchArgs =
  | { readonly kind: "ShowBacklog"; readonly json: boolean }
  | { readonly kind: "ShowAttention"; readonly json: boolean }
  | {
    readonly kind: "AddTask"
    readonly project: string
    readonly task: TaskSource
    readonly taskKind: TaskKind
    readonly internal: boolean
    readonly machine: string | null
    readonly parent: string | null
    readonly dependsOn: ReadonlyArray<string>
  }
  | { readonly kind: "CloseTask"; readonly id: string; readonly outcome: "done" | "failed"; readonly reason: string }
  | { readonly kind: "StopTask"; readonly id: string }
  | { readonly kind: "MarkPosted"; readonly id: string }
  | { readonly kind: "MarkEventPosted"; readonly key: string }
  | { readonly kind: "HoldTask"; readonly id: string; readonly reason: string; readonly until: string | null; readonly questions: ReadonlyArray<string> }
  | { readonly kind: "AnswerTask"; readonly id: string; readonly words: string }
  | { readonly kind: "DependTask"; readonly id: string; readonly dependsOn: ReadonlyArray<string> }
  | { readonly kind: "ShowPlan"; readonly parent: string }
  | { readonly kind: "DropChild"; readonly parent: string; readonly child: string }
  | { readonly kind: "MergeTask"; readonly id: string; readonly basis: MergeBasis }
  | { readonly kind: "Beat"; readonly json: boolean }
  | { readonly kind: "RunnerStart"; readonly reach: Reach }
  | { readonly kind: "RunnerQueue" }
  | { readonly kind: "RunnerLoad" }
  | { readonly kind: "RunnerRenew"; readonly reach: Reach }
  | { readonly kind: "RunnerHold"; readonly task: string; readonly label?: string; readonly run: readonly [string, ...Array<string>] }
  | { readonly kind: "RunnerToken"; readonly session: string }
  | { readonly kind: "RunnerResult"; readonly task: string; readonly label?: string; readonly json: boolean; readonly reach: Reach; readonly stdinLabel: boolean }
  | { readonly kind: "RunnerKill"; readonly task: string; readonly label?: string; readonly stdinLabel: boolean }
  | { readonly kind: "RunnerAnswer"; readonly task: string }
  | { readonly kind: "HeavyPath" }
  | { readonly kind: "HeavyCheck"; readonly json: boolean }
  | { readonly kind: "HeavyWatch" }
  | { readonly kind: "HeavyWatchOnce" }
  | { readonly kind: "UsageError"; readonly detail: string }

export const parseJsonFlag = (rest: ReadonlyArray<string>, json: (json: boolean) => DispatchArgs): DispatchArgs => {
  if (rest.length === 0) {
    return json(false)
  }
  if (rest[0] !== "--json") {
    return { kind: "UsageError", detail: "unexpected argument: " + rest[0] }
  }
  return rest.length > 1 ? { kind: "UsageError", detail: "unexpected argument: " + rest[1] } : json(true)
}

export const unexpected = (word: string | undefined): DispatchArgs => ({ kind: "UsageError", detail: "unexpected argument: " + (word ?? "") })

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

const parseRunnerToken = (after: ReadonlyArray<string>): DispatchArgs => {
  const [session = "", ...extra] = after
  if (session === "" || session.startsWith("-")) {
    return { kind: "UsageError", detail: "orc runner token takes the path of a Claude credentials file" }
  }
  return extra.length === 0 ? { kind: "RunnerToken", session } : unexpected(extra[0])
}

type StdinMarker = { readonly words: ReadonlyArray<string>; readonly stdinLabel: boolean } | { readonly error: string }

const stripStdinMarker = (verb: "hold" | "result" | "kill", words: ReadonlyArray<string>): StdinMarker => {
  if ((verb !== "result" && verb !== "kill") || !words.includes("--stdin-label")) {
    return { words, stdinLabel: false }
  }
  const kept = words.filter((word) => word !== "--stdin-label")
  return kept.length === words.length - 1
    ? { words: kept, stdinLabel: true }
    : { error: "orc runner " + verb + " takes one --stdin-label" }
}

type TaskLabel = { readonly label: string | undefined; readonly kept: Array<string> } | { readonly error: string }

const takeTaskLabel = (verb: "hold" | "result" | "kill", words: ReadonlyArray<string>): TaskLabel => {
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

const parseRunnerTask = (verb: "hold" | "result" | "kill", split: Extract<ReachSplit, { readonly kind: "split" }>): DispatchArgs => {
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
  if (verb === "kill") {
    return taken.kept.length === 0 && split.reach.kind === "here"
      ? { kind: "RunnerKill", task, ...(taken.label === undefined ? {} : { label: taken.label }), stdinLabel: marked.stdinLabel }
      : { kind: "UsageError", detail: "orc runner kill takes a task id" }
  }
  if (split.reach.kind === "here" || taken.kept.length > 0) {
    return { kind: "UsageError", detail: "orc runner hold takes a task id, then -- and the run command" }
  }
  return { kind: "RunnerHold", task, ...(taken.label === undefined ? {} : { label: taken.label }), run: split.reach.command }
}

const parseRunnerAnswer = (split: Extract<ReachSplit, { readonly kind: "split" }>): DispatchArgs => {
  const [task = "", ...extra] = split.words
  if (!isTaskId(task)) {
    return { kind: "UsageError", detail: "orc runner answer takes a task id, got \"" + task + "\"" }
  }
  if (split.reach.kind !== "here") {
    return unexpected("--")
  }
  return extra.length === 0 ? { kind: "RunnerAnswer", task } : unexpected(extra[0])
}

export const parseRunner = (rest: ReadonlyArray<string>): DispatchArgs => {
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
  if (verb !== "start" && verb !== "renew" && verb !== "hold" && verb !== "result" && verb !== "kill" && verb !== "answer") {
    return { kind: "UsageError", detail: "orc runner takes start, queue, renew, hold, token, result, kill, answer or load" }
  }
  const split = splitReach(after)
  if (split.kind === "UsageError") {
    return split
  }
  if (verb === "answer") {
    return parseRunnerAnswer(split)
  }
  if (verb === "hold" || verb === "result" || verb === "kill") {
    return parseRunnerTask(verb, split)
  }
  if (split.words.length > 0) {
    return unexpected(split.words[0])
  }
  return { kind: verb === "start" ? "RunnerStart" : "RunnerRenew", reach: split.reach }
}
