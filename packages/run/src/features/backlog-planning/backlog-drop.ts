import { Effect, FileSystem } from "effect"
import { answeredOnly, BacklogError, closeNewTask, findTask, fullPrUrl, isHeld, landedClosing, listTasks, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { withdrawTaskItems } from "../../entities/attention/index"

export type DropTask = {
  readonly kind: "DropTask"
  readonly id: string
  readonly reason: string
}

type Requirements = FileSystem.FileSystem

const dropRefusal = (task: TaskRecord, tasks: ReadonlyArray<TaskRecord>): string | null => {
  const id = task.spec.id
  switch (task.state.kind) {
    case "taken":
    case "started": {
      return id + " is " + task.state.kind + ", and only a new task drops, so end its run with orc backlog stop " + id
    }
    case "closed": {
      return id + " is already closed " + task.state.closing.outcome
    }
    case "new": {
      break
    }
  }
  const parent = task.spec.parent
  if (parent !== null) {
    return id + " is a child of " + parent + ", so take it out of the plan with orc backlog plan " + parent + " --drop " + id
  }
  const open = tasks.filter((other) => other.spec.parent === id && other.state.kind !== "closed").map((other) => other.spec.id)
  if (open.length > 0) {
    return id + " is a parent with the open children " + open.join(", ") + ", so close them or take them out of its plan first"
  }
  const waiting = tasks.filter((other) => other.state.kind !== "closed" && other.spec.dependsOn.includes(id)).map((other) => other.spec.id)
  return waiting.length === 0 ? null : waiting.join(", ") + " waits on " + id + ", so change that with orc backlog depend first"
}

type UnclaimedClose = Extract<Extract<TaskRecord["state"], { readonly kind: "closed" }>, { readonly claim: null }>["closing"]

const closedRecord = (fresh: TaskRecord, closing: UnclaimedClose, closedAt: string): TaskRecord => ({
  ...fresh,
  hold: isHeld(fresh) ? null : fresh.hold,
  parked: answeredOnly(fresh.parked),
  state: { kind: "closed", claim: null, closing, closedAt, postedAt: null }
})

const moveNewToClosed = (
  root: string,
  id: string,
  refusal: (task: TaskRecord) => string | null,
  closing: UnclaimedClose,
  closedAt: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, Requirements> =>
  closeNewTask(root, id, (fresh) => refusal(fresh) ?? closedRecord(fresh, closing, closedAt)).pipe(
    Effect.tap(() => withdrawTaskItems(root, [id], closedAt))
  )

export const dropTask = (root: string, id: string, reason: string, closedAt: string): Effect.Effect<TaskRecord, BacklogError | TaskFileError, Requirements> =>
  Effect.gen(function*() {
    const tasks = yield* listTasks(root)
    const listed = tasks.find((task) => task.spec.id === id)
    if (listed === undefined) {
      return yield* new BacklogError({ detail: "the backlog holds no " + id })
    }
    const refused = dropRefusal(listed, tasks)
    if (refused !== null) {
      return yield* new BacklogError({ detail: refused })
    }
    return yield* moveNewToClosed(root, id, (fresh) => dropRefusal(fresh, tasks), { outcome: "dropped", reason }, closedAt)
  })

const landedRefusal = (task: TaskRecord): string | null =>
  task.state.kind === "new" && task.parked !== null && task.spec.kind !== "decision"
    ? null
    : task.spec.id + " is not a parked task in the new backlog, so it cannot close with --landed-in"

export const closeLandedTask = (root: string, id: string, pr: string, at: string): Effect.Effect<string, BacklogError | TaskFileError, Requirements> =>
  Effect.gen(function*() {
    const url = fullPrUrl(pr)
    if (url === null) {
      return yield* new BacklogError({ detail: "orc backlog close --landed-in takes the full URL of the merged PR" })
    }
    const task = yield* findTask(root, id)
    const refused = landedRefusal(task)
    if (refused !== null) {
      return yield* new BacklogError({ detail: refused })
    }
    const closing = landedClosing(url)
    yield* moveNewToClosed(root, id, landedRefusal, closing, at)
    return closing.reason
  })
