import { isTaskId, isTaskPriority, type TaskPriority } from "../entities/backlog/index"
import { unexpected, type DispatchArgs } from "./dispatch-args-runner"

const priorityOf = (word: string): TaskPriority | null => {
  const value = /^\d$/.test(word) ? Number(word) : -1
  return isTaskPriority(value) ? value : null
}

export const addPriority = (words: ReadonlyArray<string>): { readonly kind: "priority"; readonly priority: TaskPriority | null } | { readonly kind: "refused"; readonly detail: string } => {
  if (words.length > 1) {
    return { kind: "refused", detail: "orc backlog add takes one --priority" }
  }
  const word = words.at(0)
  if (word === undefined) {
    return { kind: "priority", priority: null }
  }
  const priority = priorityOf(word)
  return priority === null ? { kind: "refused", detail: "orc backlog add takes 0 to 4 after --priority, got \"" + word + "\"" } : { kind: "priority", priority }
}

export const parsePriority = (rest: ReadonlyArray<string>): DispatchArgs => {
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
