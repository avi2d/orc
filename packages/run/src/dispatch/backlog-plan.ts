import { Effect, FileSystem } from "effect"
import { backlogPaths, BacklogError, listTasks } from "./backlog"
import { grabbedFile, scratchName, takeFile } from "./backlog-write"
import { childCount, dependencyOpen, splitSiblingUnmerged } from "./beat-place"
import { mergedIds } from "./events"
import { isHeld, parseTaskFile, type TaskFileError, type TaskRecord } from "./task-record"

type Requirements = FileSystem.FileSystem

const parentIn = (tasks: ReadonlyArray<TaskRecord>, id: string): Effect.Effect<TaskRecord, BacklogError> => {
  const parent = tasks.find((task) => task.spec.id === id)
  if (parent === undefined) {
    return Effect.fail(new BacklogError({ detail: "the backlog holds no " + id }))
  }
  return parent.spec.kind === "parent"
    ? Effect.succeed(parent)
    : Effect.fail(new BacklogError({ detail: id + " is a " + parent.spec.kind + " task, and only a parent task has a plan" }))
}

const shipState = (child: TaskRecord, merged: ReadonlySet<string>): string => {
  const pr = child.spec.kind === "ship" && child.state.kind === "closed" && child.state.closing.outcome !== "start-failed" ? child.state.closing.pr : null
  return pr === null ? "" : merged.has(child.spec.id) ? " merged" : " waits for its PR to merge"
}

const childState = (child: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string => {
  switch (child.state.kind) {
    case "new": {
      const open = child.spec.dependsOn.filter((id) => {
        const dependency = tasks.find((task) => task.spec.id === id)
        return dependency !== undefined && (dependencyOpen(dependency) || splitSiblingUnmerged(child, dependency, merged))
      })
      return "new" + (open.length === 0 ? "" : " waits " + open.join(",")) + (isHeld(child) ? " held" : "")
    }
    case "taken": {
      return "taken"
    }
    case "started": {
      return "started on " + child.state.claim.machine
    }
    case "closed": {
      return child.state.closing.outcome + shipState(child, merged)
    }
  }
}

export const planText = (root: string, id: string): Effect.Effect<string, BacklogError | TaskFileError, Requirements> =>
  Effect.gen(function*() {
    const tasks = yield* listTasks(root)
    const merged = yield* mergedIds(root)
    const parent = yield* parentIn(tasks, id)
    const count = childCount(parent, tasks, merged)
    const children = tasks.filter((task) => task.spec.parent === id)
    return [
      parent.spec.id + " parent " + parent.spec.project + " " + count.done + " of " + count.total + " done " + parent.spec.title,
      parent.spec.split === null ? "split by hand" : "split at " + parent.spec.split.by + ": " + parent.spec.split.reason,
      ...children.map((child) => child.spec.id + " " + childState(child, tasks, merged) + " " + child.spec.title)
    ].join("\n")
  })

const droppable = (child: TaskRecord, parent: string, tasks: ReadonlyArray<TaskRecord>): string | null => {
  const id = child.spec.id
  if (child.spec.parent !== parent) {
    return id + " is not a child of " + parent
  }
  if (child.state.kind !== "new") {
    return id + " is " + child.state.kind + ", and only a new child leaves the plan"
  }
  if (child.parked !== null) {
    return id + " is parked on " + child.parked.branch + ", and only a child that never ran leaves the plan"
  }
  const waiting = tasks.filter((task) => task.state.kind !== "closed" && task.spec.dependsOn.includes(id)).map((task) => task.spec.id)
  return waiting.length === 0 ? null : waiting.join(", ") + " waits on " + id + ", so change that with orc backlog depend first"
}

// rename(2) takes the one task file at most once, so a beat's claim and a drop never both get the child.
const removeNew = (root: string, child: TaskRecord, parent: string, tasks: ReadonlyArray<TaskRecord>): Effect.Effect<void, BacklogError | TaskFileError, Requirements> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const id = child.spec.id
    const file = paths.taskFile("new", id)
    const grabbed = scratchName(paths.folder("new"), id)
    if (!(yield* takeFile(fs, file, grabbed, id))) {
      return yield* new BacklogError({ detail: id + " moved while orc read it, so run the command again" })
    }
    const { putBack, read } = grabbedFile(fs, file, grabbed, id)
    const refused = yield* read.pipe(
      Effect.flatMap((text) => parseTaskFile(file, "new", text)),
      Effect.map((fresh) => droppable(fresh, parent, tasks)),
      Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error))))
    )
    if (refused !== null) {
      yield* putBack
      return yield* new BacklogError({ detail: refused })
    }
    yield* fs.remove(grabbed).pipe(Effect.mapError((error) => new BacklogError({ detail: "cannot remove " + grabbed + ": " + error.message })))
  })

export const dropChild = (root: string, parent: string, child: string): Effect.Effect<string, BacklogError | TaskFileError, Requirements> =>
  Effect.gen(function*() {
    const tasks = yield* listTasks(root)
    const record = yield* parentIn(tasks, parent)
    const dropped = tasks.find((task) => task.spec.id === child)
    if (dropped === undefined) {
      return yield* new BacklogError({ detail: "the backlog holds no " + child })
    }
    const refused = droppable(dropped, parent, tasks)
    if (refused !== null) {
      return yield* new BacklogError({ detail: refused })
    }
    yield* removeNew(root, dropped, parent, tasks)
    const left = childCount(record, tasks.filter((task) => task.spec.id !== child), yield* mergedIds(root))
    return "dropped " + child + " from the plan of " + parent + ", which now waits on " + left.total + " children, " + left.done + " of them done"
  })
