import { Effect, FileSystem } from "effect"
import { BacklogError, findTask, isTaskId, type Rewrite, rewriteNew } from "../entities/backlog/index"
import { openQuestions, type TaskFileError, type TaskRecord } from "../entities/backlog/index"

const waitsFor = (id: string, tasks: ReadonlyArray<TaskRecord>): ReadonlyArray<string> => [
  ...(tasks.find((task) => task.spec.id === id)?.spec.dependsOn ?? []),
  ...tasks.filter((task) => task.spec.parent === id).map((child) => child.spec.id)
]

const waitsOn = (from: string, target: string, tasks: ReadonlyArray<TaskRecord>): boolean => {
  const seen = new Set<string>()
  const pending = [from]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === target) {
      return true
    }
    if (!seen.has(id)) {
      seen.add(id)
      pending.push(...waitsFor(id, tasks))
    }
  }
  return false
}

const refusedParent = (parent: string, dependsOn: ReadonlyArray<string>, tasks: ReadonlyArray<TaskRecord>): string | null => {
  const record = tasks.find((task) => task.spec.id === parent)
  if (record === undefined) {
    return "the backlog holds no task " + parent
  }
  if (record.spec.kind !== "parent") {
    return parent + " is a " + record.spec.kind + " task, and only a parent task takes children"
  }
  if (record.state.kind !== "new") {
    return parent + " is " + record.state.kind + ", and only a new parent takes another child"
  }
  const loop = dependsOn.find((id) => waitsOn(id, parent, tasks))
  return loop === undefined ? null : loop + " waits on " + parent + ", which waits on its children, so a child of " + parent + " cannot wait on it"
}

export const refusedLinks = (parent: string | null, dependsOn: ReadonlyArray<string>, tasks: ReadonlyArray<TaskRecord>): string | null => {
  const missing = dependsOn.find((id) => !isTaskId(id) || !tasks.some((task) => task.spec.id === id))
  if (missing !== undefined) {
    return "the backlog holds no task " + missing
  }
  return parent === null ? null : refusedParent(parent, dependsOn, tasks)
}

export const circularDependency = (id: string, dependsOn: ReadonlyArray<string>, tasks: ReadonlyArray<TaskRecord>): string | null => {
  const loop = dependsOn.find((dependency) => waitsOn(dependency, id, tasks))
  if (loop === undefined) {
    return null
  }
  return loop === id
    ? id + " cannot wait on itself"
    : loop + " already waits on " + id + ", so " + id + " waiting on " + loop + " would hold both forever"
}

export type DependOutcome = "set" | "unchanged"

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const dependOn = (id: string, dependsOn: ReadonlyArray<string>) => (fresh: TaskRecord): Effect.Effect<Rewrite<DependOutcome>, BacklogError> => {
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " is " + fresh.state.kind + ", and only a new or held task takes other dependencies" }))
  }
  if (openQuestions(fresh).length > 0) {
    return Effect.fail(new BacklogError({ detail: id + " is parked for the captain's answer, and only a new or held task takes other dependencies" }))
  }
  if (sameIds(fresh.spec.dependsOn, dependsOn)) {
    return Effect.succeed({ kind: "keep", result: "unchanged" })
  }
  return Effect.succeed({ kind: "write", record: { ...fresh, spec: { ...fresh.spec, dependsOn } }, result: "set" })
}

export const dependTask = (
  root: string,
  id: string,
  dependsOn: ReadonlyArray<string>
): Effect.Effect<DependOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decide = dependOn(id, dependsOn)
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })
