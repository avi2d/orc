import { Effect, FileSystem } from "effect"
import { answeredOnly, backlogPaths, BacklogError, grabbedFile, isHeld, listTasks, parseTaskFile, platformFailure, publishOnce, renderTaskFile, scratchName, takeFile, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"

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

const droppedRecord = (fresh: TaskRecord, reason: string, closedAt: string): TaskRecord => ({
  ...fresh,
  hold: isHeld(fresh) ? null : fresh.hold,
  parked: answeredOnly(fresh.parked),
  state: { kind: "closed", claim: null, closing: { outcome: "dropped", reason }, closedAt, postedAt: null }
})

// rename(2) takes the one task file at most once, so a beat's claim and a drop never both get the task.
const moveDropped = (root: string, listed: TaskRecord, tasks: ReadonlyArray<TaskRecord>, reason: string, closedAt: string): Effect.Effect<TaskRecord, BacklogError | TaskFileError, Requirements> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const id = listed.spec.id
    const file = paths.taskFile("new", id)
    const grabbed = scratchName(paths.folder("new"), id)
    if (!(yield* takeFile(fs, file, grabbed, id))) {
      return yield* new BacklogError({ detail: id + " moved while orc read it, so run the command again" })
    }
    const { putBack, read } = grabbedFile(fs, file, grabbed, id)
    const settle = Effect.gen(function*() {
      const fresh = yield* parseTaskFile(file, "new", yield* read)
      const refused = dropRefusal(fresh, tasks)
      if (refused !== null) {
        return yield* new BacklogError({ detail: refused })
      }
      const dropped = droppedRecord(fresh, reason, closedAt)
      if (!(yield* publishOnce(paths.folder("closed"), id + ".md", renderTaskFile(dropped)))) {
        return yield* new BacklogError({ detail: id + " was closed by another command" })
      }
      return dropped
    })
    const dropped = yield* settle.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return dropped
  })

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
    return yield* moveDropped(root, listed, tasks, reason, closedAt)
  })
