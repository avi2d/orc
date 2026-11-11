import { parentLabel, taskLabel } from "../shared/process/index"
import type { TaskKind } from "../task-kind"

export const taskBranch = (task: string): string => "orc/" + task

export const parentBranch = (task: string): string => taskBranch(task) + "-parent"

export const labelOf = (home: string, task: string, label?: string | null): string => label ?? taskLabel(home, task)

export const runLabel = (home: string, task: string, kind: TaskKind | undefined, label?: string | null): string =>
  label ?? (kind === "parent" ? parentLabel(home, task) : taskLabel(home, task))

export const fileKeyOf = (home: string, task: string, label: string): string => label === taskLabel(home, task) ? task : "label-" + encodeURIComponent(label)
