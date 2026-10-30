import { isTaskId } from "./backlog"

export type Reach = { readonly kind: "here" } | { readonly kind: "through"; readonly command: readonly [string, ...Array<string>] }

export type DispatchArgs =
  | { readonly kind: "ShowBacklog"; readonly json: boolean }
  | {
    readonly kind: "AddTask"
    readonly project: string
    readonly taskFile: string
    readonly machine: string | null
    readonly dependsOn: ReadonlyArray<string>
  }
  | { readonly kind: "CloseTask"; readonly id: string; readonly outcome: "done" | "failed"; readonly reason: string }
  | { readonly kind: "Beat"; readonly json: boolean }
  | { readonly kind: "RunnerStart"; readonly reach: Reach }
  | { readonly kind: "RunnerQueue" }
  | { readonly kind: "RunnerRenew"; readonly reach: Reach }
  | { readonly kind: "RunnerHold"; readonly task: string; readonly run: readonly [string, ...Array<string>] }
  | { readonly kind: "RunnerToken"; readonly session: string }
  | { readonly kind: "RunnerResult"; readonly task: string; readonly json: boolean; readonly reach: Reach }
  | { readonly kind: "UsageError"; readonly detail: string }

export const dispatchUsage =
  "orc backlog [--json] | orc backlog add <project> <task-file> [--machine <name>] [--depends-on <task-id>] | orc backlog close <task-id> <done|failed> [reason] | orc beat [--json] | orc runner start [-- <command that runs orc there>] | orc runner queue | orc runner renew [-- <command that runs orc there>] | orc runner hold <task-id> -- <run command> | orc runner token <clauth session-token.json> | orc runner result <task-id> [--json] [-- <command that runs orc there>]"

const parseJsonFlag = (rest: ReadonlyArray<string>, json: (json: boolean) => DispatchArgs): DispatchArgs => {
  if (rest.length === 0) {
    return json(false)
  }
  if (rest[0] !== "--json") {
    return { kind: "UsageError", detail: "unexpected argument: " + rest[0] }
  }
  return rest.length > 1 ? { kind: "UsageError", detail: "unexpected argument: " + rest[1] } : json(true)
}

const parseAdd = (rest: ReadonlyArray<string>): DispatchArgs => {
  const kept: Array<string> = []
  let machine: string | null = null
  const dependsOn: Array<string> = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ""
    if (token !== "--machine" && token !== "--depends-on") {
      kept.push(token)
      continue
    }
    const value = rest[index + 1] ?? ""
    if (value === "" || value.startsWith("--")) {
      return { kind: "UsageError", detail: "orc backlog add takes a value after " + token }
    }
    if (token === "--machine") {
      if (machine !== null) {
        return { kind: "UsageError", detail: "orc backlog add takes one --machine" }
      }
      machine = value
    } else {
      dependsOn.push(value)
    }
    index += 1
  }
  if (kept.length !== 2) {
    return { kind: "UsageError", detail: "orc backlog add takes a project and a task file" }
  }
  const [project = "", taskFile = ""] = kept
  return { kind: "AddTask", project, taskFile, machine, dependsOn }
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

const parseRunnerToken = (after: ReadonlyArray<string>): DispatchArgs => {
  const [session = "", ...extra] = after
  if (session === "" || session.startsWith("-")) {
    return { kind: "UsageError", detail: "orc runner token takes the path of a clauth session-token.json" }
  }
  return extra.length === 0 ? { kind: "RunnerToken", session } : unexpected(extra[0])
}

const parseRunnerTask = (verb: "hold" | "result", split: Extract<ReachSplit, { readonly kind: "split" }>): DispatchArgs => {
  const [task = "", ...flags] = split.words
  if (!isTaskId(task)) {
    return { kind: "UsageError", detail: "orc runner " + verb + " takes a task id, got \"" + task + "\"" }
  }
  if (verb === "result") {
    return parseJsonFlag(flags, (json) => ({ kind: "RunnerResult", task, json, reach: split.reach }))
  }
  if (split.reach.kind === "here" || flags.length > 0) {
    return { kind: "UsageError", detail: "orc runner hold takes a task id, then -- and the run command" }
  }
  return { kind: "RunnerHold", task, run: split.reach.command }
}

const parseRunner = (rest: ReadonlyArray<string>): DispatchArgs => {
  const [verb = "", ...after] = rest
  if (verb === "queue") {
    return after.length === 0 ? { kind: "RunnerQueue" } : unexpected(after[0])
  }
  if (verb === "token") {
    return parseRunnerToken(after)
  }
  if (verb !== "start" && verb !== "renew" && verb !== "hold" && verb !== "result") {
    return { kind: "UsageError", detail: "orc runner takes start, queue, renew, hold, token or result" }
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

export const parseDispatchArgs = (command: "backlog" | "beat" | "runner", rest: ReadonlyArray<string>): DispatchArgs => {
  if (command === "runner") {
    return parseRunner(rest)
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
  return parseJsonFlag(rest, (json) => ({ kind: "ShowBacklog", json }))
}
