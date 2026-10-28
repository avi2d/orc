import { Data, Effect, FileSystem, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { parseTaskFile, renderTaskFile, type TaskFileError, type TaskFolder, taskFolders, type TaskRecord, type TaskSpec } from "./task-record"

export class BacklogError extends Data.TaggedError("BacklogError")<{
  readonly detail: string
}> {}

const taskFilePattern = /^task-(\d+)\.md$/
const idPattern = /^task-(\d+)$/

const taskNumber = (id: string): number => Number(idPattern.exec(id)?.[1] ?? Number.NaN)

export const isTaskId = (id: string): boolean => idPattern.test(id)

export const TaskId = Schema.String.check(Schema.isPattern(idPattern))

interface BacklogPaths {
  readonly root: string
  readonly ids: string
  readonly logs: string
  readonly logFile: (id: string) => string
  readonly dispatchConfig: string
  readonly projects: string
  readonly folder: (folder: TaskFolder) => string
  readonly taskFile: (folder: TaskFolder, id: string) => string
}

export const backlogPaths = (root: string): BacklogPaths => ({
  root,
  ids: root + "/ids",
  logs: root + "/logs",
  logFile: (id: string): string => root + "/logs/" + id + ".log",
  dispatchConfig: root + "/dispatch.json",
  projects: root + "/projects.json",
  folder: (folder: TaskFolder): string => root + "/" + folder,
  taskFile: (folder: TaskFolder, id: string): string => root + "/" + folder + "/" + id + ".md"
})

const platformFailure = (action: string) => (error: PlatformError): BacklogError =>
  new BacklogError({ detail: "cannot " + action + ": " + error.message })

export const ensureBacklog = (root: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    for (const folder of [paths.ids, paths.logs, ...taskFolders.map(paths.folder)]) {
      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    }
  })

const readNames = (folder: string): Effect.Effect<ReadonlyArray<string>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readDirectory(folder).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(platformFailure("list " + folder))
    )
  })

const byTaskNumber = (left: TaskRecord, right: TaskRecord): number => taskNumber(left.spec.id) - taskNumber(right.spec.id)

// A beat may move a listed file to the next folder before it is read, so a vanished file is skipped rather than failed.
const readFolder = (
  root: string,
  folder: TaskFolder
): Effect.Effect<ReadonlyArray<TaskRecord>, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const records: Array<TaskRecord> = []
    for (const name of yield* readNames(paths.folder(folder))) {
      if (!taskFilePattern.test(name)) {
        continue
      }
      const file = paths.folder(folder) + "/" + name
      const text = yield* fs.readFileString(file).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
        Effect.mapError(platformFailure("read " + file))
      )
      if (text !== null) {
        records.push(yield* parseTaskFile(file, folder, text))
      }
    }
    return records
  })

// A close links the closed copy before it removes the taken one, so for a moment both are listed and the closed copy wins.
export const listTasks = (
  root: string
): Effect.Effect<ReadonlyArray<TaskRecord>, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.forEach(taskFolders, (folder) => readFolder(root, folder)).pipe(
    Effect.map((folders) => {
      const all = folders.flat()
      const closed = new Set(all.filter((record) => record.state.kind === "closed").map((record) => record.spec.id))
      return all.filter((record) => record.state.kind === "closed" || !closed.has(record.spec.id)).sort(byTaskNumber)
    })
  )

const scratchName = (folder: string, id: string): string => folder + "/." + id + "." + crypto.randomUUID() + ".tmp"

// link(2) refuses an existing name, so the file appears whole and at most once.
const publishOnce = (
  folder: string,
  id: string,
  text: string
): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const scratch = scratchName(folder, id)
    const file = folder + "/" + id + ".md"
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    const published = yield* fs.link(scratch, file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.mapError(platformFailure("write " + file))
    )
    yield* fs.remove(scratch).pipe(Effect.mapError(platformFailure("remove " + scratch)))
    return published
  })

const reserveId = (root: string): Effect.Effect<string, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const taken = (yield* readNames(paths.ids)).map(taskNumber).filter(Number.isFinite)
    let next = Math.max(0, ...taken) + 1
    for (;;) {
      const id = "task-" + next
      const reserved = yield* fs.writeFileString(paths.ids + "/" + id, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
        Effect.mapError(platformFailure("reserve " + id))
      )
      if (reserved) {
        return id
      }
      next += 1
    }
  })

export const addTask = (
  root: string,
  spec: Omit<TaskSpec, "id">
): Effect.Effect<TaskRecord, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    yield* ensureBacklog(root)
    const id = yield* reserveId(root)
    const record: TaskRecord = { spec: { ...spec, id }, state: { kind: "new" } }
    if (!(yield* publishOnce(backlogPaths(root).folder("new"), id, renderTaskFile(record)))) {
      return yield* new BacklogError({ detail: "the reserved id " + id + " already names a task" })
    }
    return record
  })

// rename(2) moves the one file in new/ at most once, so of two beats racing for a task exactly one gets true.
export const claimTask = (root: string, id: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    return yield* fs.rename(paths.taskFile("new", id), paths.taskFile("taken", id)).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.mapError(platformFailure("take " + id))
    )
  })

// The beat gives back only a task it took and has not started, so no other command holds its taken file.
export const releaseTask = (root: string, record: TaskRecord): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const unclaimed: TaskRecord = { spec: record.spec, state: { kind: "new" } }
    yield* writeTaken(root, unclaimed)
    yield* fs.rename(paths.taskFile("taken", record.spec.id), paths.taskFile("new", record.spec.id)).pipe(
      Effect.mapError(platformFailure("give back " + record.spec.id))
    )
  })

// Only the beat that took a task writes its taken file, and only until it is started or closed.
export const writeTaken = (root: string, record: TaskRecord): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const file = paths.taskFile("taken", record.spec.id)
    const scratch = scratchName(paths.folder("taken"), record.spec.id)
    yield* fs.writeFileString(scratch, renderTaskFile(record)).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })

export const publishClosed = (root: string, record: TaskRecord): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    if (!(yield* publishOnce(paths.folder("closed"), record.spec.id, renderTaskFile(record)))) {
      return false
    }
    const taken = paths.taskFile("taken", record.spec.id)
    yield* fs.remove(taken).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.mapError(platformFailure("remove " + taken))
    )
    return true
  })

export const closeStartedTask = (
  root: string,
  id: string,
  outcome: "done" | "failed",
  reason: string,
  closedAt: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = (yield* listTasks(root)).find((candidate) => candidate.spec.id === id)
    if (record === undefined) {
      return yield* new BacklogError({ detail: "the backlog holds no " + id })
    }
    if (record.state.kind !== "started") {
      return yield* new BacklogError({ detail: id + " is " + record.state.kind + ", and only a started task closes" })
    }
    const closed: TaskRecord = {
      spec: record.spec,
      state: { kind: "closed", claim: record.state.claim, closing: { outcome, started: record.state.started, reason }, closedAt }
    }
    if (!(yield* publishClosed(root, closed))) {
      return yield* new BacklogError({ detail: id + " was closed by another command" })
    }
    return closed
  })
