import { parentLabel, taskLabel } from "../../shared/process/index"
import type { TaskKind } from "./task-kind"
import { isTaskId } from "./backlog"

const taskBranchPrefix = "orc/"

export const taskBranch = (task: string): string => taskBranchPrefix + task

export const taskOfBranch = (branch: string): string | null => {
  const task = branch.startsWith(taskBranchPrefix) ? branch.slice(taskBranchPrefix.length) : null
  const id = task !== null && task.endsWith("-parent") ? task.slice(0, -"-parent".length) : task
  return id !== null && isTaskId(id) ? id : null
}

export const parentBranch = (task: string): string => taskBranch(task) + "-parent"

export const labelOf = (home: string, task: string, label?: string | null): string => label ?? taskLabel(home, task)

export const runLabel = (home: string, task: string, kind: TaskKind | undefined, label?: string | null): string =>
  label ?? (kind === "parent" ? parentLabel(home, task) : taskLabel(home, task))

export const fileKeyOf = (home: string, task: string, label: string): string => label === taskLabel(home, task) ? task : "label-" + encodeURIComponent(label)
