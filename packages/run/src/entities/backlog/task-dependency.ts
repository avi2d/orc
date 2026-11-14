import { taskPr, type TaskRecord } from "./task-record"

const dependencyOpen = (dependency: TaskRecord | undefined): boolean =>
  dependency === undefined || dependency.state.kind !== "closed" || dependency.state.closing.outcome !== "done"

export interface ChildCount {
  readonly done: number
  readonly total: number
}

const childDone = (child: TaskRecord, merged: ReadonlySet<string>): boolean => {
  if (dependencyOpen(child)) {
    return false
  }
  if (child.spec.kind !== "ship") {
    return true
  }
  const pr = taskPr(child)
  return pr === null || merged.has(child.spec.id)
}

export const childCount = (parent: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): ChildCount => {
  const children = tasks.filter((task) => task.spec.parent === parent.spec.id)
  return { done: children.filter((child) => childDone(child, merged)).length, total: children.length }
}

export const dependencyWaits = (task: TaskRecord, dependency: TaskRecord | undefined, merged: ReadonlySet<string>): boolean =>
  dependencyOpen(dependency) || (dependency !== undefined && shipPrerequisiteUnmerged(task, dependency, merged))

const shipPrerequisiteUnmerged = (task: TaskRecord, dependency: TaskRecord, merged: ReadonlySet<string>): boolean => {
  if (task.spec.kind !== "ship" || dependency.spec.kind !== "ship") {
    return false
  }
  const pr = taskPr(dependency)
  return pr !== null && !merged.has(dependency.spec.id)
}
