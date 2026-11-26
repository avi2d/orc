import { DateTime, Effect, FileSystem, Option } from "effect"
import { applyRunSplit, closeStartedTask, findTask, listTasks, splitEventText, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { recordEvent } from "../../entities/events/index"
import type { BeatAction } from "../../entities/attention/index"
import type { RunEnding } from "../../features/queueing-a-task/index"

type SplitEnding = Extract<RunEnding, { readonly kind: "split" }>

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

const childIdsOf = (tasks: ReadonlyArray<TaskRecord>, parent: string): ReadonlyArray<string> =>
  tasks.filter((candidate) => candidate.spec.parent === parent).map((candidate) => candidate.spec.id)

const siblingIdsOf = (tasks: ReadonlyArray<TaskRecord>, parent: string, created: string): ReadonlyArray<string> =>
  tasks.filter((candidate) => candidate.spec.parent === parent && candidate.spec.created === created).map((candidate) => candidate.spec.id)

const splitFailureText = (id: string, children: ReadonlyArray<string>, detail: string): string =>
  "split " + id + " into " + (children.length === 0 ? "no children" : children.join(", ")) + " failed: " + detail

const listTasksOrEmpty = (root: string): Effect.Effect<ReadonlyArray<TaskRecord>, never, FileSystem.FileSystem> =>
  listTasks(root).pipe(Effect.catchTag(["BacklogError", "TaskFileError"], () => Effect.succeed([] as ReadonlyArray<TaskRecord>)))

const endSplitParentFailure = (
  root: string,
  id: string,
  machine: string,
  detail: string
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const children = childIdsOf(yield* listTasksOrEmpty(root), id)
    return Option.some({ kind: "close-failed", task: id, machine, reason: splitFailureText(id, children, detail) } satisfies BeatAction)
  })

const endSplitFailure = (
  root: string,
  task: TaskRecord,
  machine: string,
  detail: string,
  at: string
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    const reopened = yield* findTask(root, id).pipe(Effect.catchTag(["BacklogError", "TaskFileError"], () => Effect.succeed(null)))
    if (reopened !== null && reopened.state.kind === "new" && reopened.spec.kind === "parent") {
      return yield* endSplitParentFailure(root, id, machine, detail)
    }
    const parent = task.spec.parent
    if (parent === null || reopened === null) {
      return Option.none()
    }
    const created = siblingIdsOf(yield* listTasksOrEmpty(root), parent, at)
    const reason = splitFailureText(id, created, detail)
    const closed = yield* closeStartedTask(root, id, "failed", reason, { pr: null, report: null }, at).pipe(
      Effect.catchTag("BacklogError", () => Effect.succeed(null))
    )
    return closed === null || closed.state.kind !== "closed"
      ? Option.none()
      : Option.some({ kind: "closed", task: id, machine, outcome: "failed", reason: closed.state.closing.reason, pr: null, report: null } satisfies BeatAction)
  })

export const endSplit = (
  root: string,
  task: TaskRecord,
  machine: string,
  ending: SplitEnding
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    const at = yield* nowIso
    const applied = yield* applyRunSplit(root, task, ending.plan, at).pipe(
      Effect.map((value) => ({ kind: "applied" as const, value })),
      Effect.catchTags({
        BacklogError: (error) => Effect.succeed({ kind: "failed" as const, detail: error.detail }),
        TaskFileError: (error) => Effect.succeed({ kind: "failed" as const, detail: error.detail })
      })
    )
    if (applied.kind === "applied") {
      const reason = ending.plan.reason.trim()
      yield* recordEvent(root, { key: id + ".split", at, text: splitEventText(applied.value, "run", reason) }).pipe(Effect.catchTag("BacklogError", () => Effect.void))
      return Option.some({ kind: "split", task: id, machine, children: applied.value.children.map((child) => child.spec.id), reason } satisfies BeatAction)
    }
    return yield* endSplitFailure(root, task, machine, applied.detail, at)
  })
