import { Effect, type FileSystem } from "effect"
import { BacklogError, findTask, type Rewrite, rewriteNew, type TaskFileError, type TaskPriority, type TaskRecord } from "../../entities/backlog/index"

export type PriorityOutcome = "set" | "unchanged"

const prioritize = (id: string, priority: TaskPriority | null) => (fresh: TaskRecord): Effect.Effect<Rewrite<PriorityOutcome>, BacklogError> => {
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " is " + fresh.state.kind + ", and only a new task takes a priority" }))
  }
  if (fresh.spec.priority === priority) {
    return Effect.succeed({ kind: "keep", result: "unchanged" })
  }
  return Effect.succeed({ kind: "write", record: { ...fresh, spec: { ...fresh.spec, priority } }, result: "set" })
}

// A taken task belongs to a live beat that goes on writing its taken file, so only a new one is rewritten.
export const prioritizeTask = (
  root: string,
  id: string,
  priority: TaskPriority | null
): Effect.Effect<PriorityOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decide = prioritize(id, priority)
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })

export const priorityLine = (id: string, priority: TaskPriority | null, outcome: PriorityOutcome): string => {
  const named = priority === null ? "no priority" : "P" + priority
  return outcome === "set" ? id + " now has " + named : id + " already has " + named
}
