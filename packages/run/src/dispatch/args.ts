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
  | { readonly kind: "UsageError"; readonly detail: string }

export const dispatchUsage =
  "orc backlog [--json] | orc backlog add <project> <task-file> [--machine <name>] [--depends-on <task-id>] | orc backlog close <task-id> <done|failed> [reason] | orc beat [--json]"

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

export const parseDispatchArgs = (command: "backlog" | "beat", rest: ReadonlyArray<string>): DispatchArgs => {
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
