import { Effect, FileSystem } from "effect"
import { BacklogError, findTask, type Rewrite, rewriteNew } from "./backlog"
import { openQuestions, type TaskFileError, type TaskRecord } from "./task-record"

const waitsOn = (from: string, target: string, tasks: ReadonlyArray<TaskRecord>): boolean => {
  const seen = new Set<string>()
  const pending = [from]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === target) {
      return true
    }
    if (!seen.has(id)) {
      seen.add(id)
      pending.push(...(tasks.find((task) => task.spec.id === id)?.spec.dependsOn ?? []))
    }
  }
  return false
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
