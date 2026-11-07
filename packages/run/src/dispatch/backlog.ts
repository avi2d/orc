import { Array as Arr, Effect, FileSystem, Schema } from "effect"
import { captainWait, type Parked, parseTaskFile, type TaskFileError, type TaskFolder, taskFolders, type TaskRecord, type TaskSpec } from "./task-record"
import { renderTaskFile } from "./task-record-render"
import { BacklogError, backlogPaths, grabbedFile, platformFailure, publishOnce, scratchName, takeFile, takenGrab } from "./backlog-write"

export { BacklogError, backlogPaths, takenGrab, type BacklogPaths } from "./backlog-write"

// A project name may hold dashes, so an id splits at its last dash.
const idPattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+)$/
const taskFilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*-\d+\.md$/

const splitId = (id: string): { readonly project: string; readonly number: number } | null => {
  const split = idPattern.exec(id)
  return split === null ? null : { project: split[1], number: Number(split[2]) }
}

export const isTaskId = (id: string): boolean => idPattern.test(id)

export const TaskId = Schema.String.check(Schema.isPattern(idPattern))

export const ensureBacklog = (root: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    for (const folder of [paths.ids, paths.logs, ...taskFolders.map(paths.folder)]) {
      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    }
  })

export const readNames = (folder: string): Effect.Effect<ReadonlyArray<string>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readDirectory(folder).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(platformFailure("list " + folder))
    )
  })

const byCreated = (left: TaskRecord, right: TaskRecord): number =>
  left.spec.created.localeCompare(right.spec.created) || left.spec.id.localeCompare(right.spec.id, "en", { numeric: true })

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
      return all.filter((record) => record.state.kind === "closed" || !closed.has(record.spec.id)).sort(byCreated)
    })
  )

// An old task-<n> id names no project, so its task file says which project it counts for.
const reserveId = (root: string, project: string): Effect.Effect<string, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const tasks = yield* listTasks(root).pipe(
      Effect.catchTag("TaskFileError", (error) => Effect.fail(new BacklogError({ detail: "cannot read " + error.file + ": " + error.detail })))
    )
    const own = [
      ...(yield* readNames(paths.ids)).map(splitId).filter((split) => split?.project === project),
      ...tasks.filter((task) => task.spec.project === project).map((task) => splitId(task.spec.id))
    ]
    let next = Math.max(0, ...own.map((split) => split?.number ?? 0)) + 1
    for (;;) {
      const id = project + "-" + next
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
    const id = yield* reserveId(root, spec.project)
    const record: TaskRecord = { spec: { ...spec, id }, hold: null, parked: null, state: { kind: "new" } }
    if (!(yield* publishOnce(backlogPaths(root).folder("new"), id + ".md", renderTaskFile(record)))) {
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

type Claimed =
  | { readonly kind: "claimed"; readonly record: TaskRecord }
  | { readonly kind: "lost" }
  | { readonly kind: "held"; readonly reason: string }

// A hold can land after a beat listed the task, so the file the claim took is read again and a held or parked one goes back to new.
export const claimUnheld = (root: string, id: string): Effect.Effect<Claimed, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = (yield* claimTask(root, id)) ? yield* readTask(root, "taken", id) : null
    if (record === null) {
      return { kind: "lost" } satisfies Claimed
    }
    const reason = captainWait(record)
    if (reason === null) {
      return { kind: "claimed", record } satisfies Claimed
    }
    yield* releaseTask(root, record)
    return { kind: "held", reason } satisfies Claimed
  })

// The beat gives back only a task it took and has not started, so no other command holds its taken file.
export const releaseTask = (root: string, record: TaskRecord): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const unclaimed: TaskRecord = { ...record, state: { kind: "new" } }
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
    if (!(yield* publishOnce(paths.folder("closed"), record.spec.id + ".md", renderTaskFile(record)))) {
      return false
    }
    const taken = paths.taskFile("taken", record.spec.id)
    yield* fs.remove(taken).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.mapError(platformFailure("remove " + taken))
    )
    return true
  })

const answeredOnly = (parked: Parked | null): Parked | null => {
  const answered = parked?.questions.filter((question) => question.answer !== null) ?? []
  return parked !== null && Arr.isReadonlyArrayNonEmpty(answered) ? { ...parked, questions: answered } : null
}

const missedClose = (
  root: string,
  id: string
): Effect.Effect<never, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const takenNames = yield* fs.readDirectory(paths.folder("taken")).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    if (takenNames.some((name) => name.startsWith("." + id + "."))) {
      return yield* new BacklogError({ detail: id + " moved while orc read it, so run the command again" })
    }
    const closedExists = yield* fs.exists(paths.taskFile("closed", id)).pipe(Effect.mapError(platformFailure("read " + id)))
    if (closedExists) {
      return yield* new BacklogError({ detail: id + " was closed by another command" })
    }
    const record = (yield* listTasks(root)).find((candidate) => candidate.spec.id === id)
    if (record === undefined) {
      return yield* new BacklogError({ detail: "the backlog holds no " + id })
    }
    if (record.state.kind !== "started") {
      return yield* new BacklogError({ detail: id + " is " + record.state.kind + ", and only a started task closes" })
    }
    return yield* new BacklogError({ detail: id + " moved while orc read it, so run the command again" })
  })

export const closeStartedTask = (
  root: string,
  id: string,
  outcome: "done" | "failed" | "stopped",
  reason: string,
  delivered: { readonly pr: string | null; readonly report: string | null },
  closedAt: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* takenGrab(root, id, missedClose(root, id))
    const text = yield* read.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    const fresh = yield* parseTaskFile(file, "taken", text).pipe(
      Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error))))
    )
    if (fresh.state.kind !== "started") {
      yield* putBack
      return yield* new BacklogError({ detail: id + " is " + fresh.state.kind + ", and only a started task closes" })
    }
    const closed: TaskRecord = {
      ...fresh,
      parked: answeredOnly(fresh.parked),
      state: { kind: "closed", claim: fresh.state.claim, closing: { outcome, started: fresh.state.started, reason, ...delivered }, closedAt, postedAt: null }
    }
    const published = yield* publishOnce(paths.folder("closed"), id + ".md", renderTaskFile(closed)).pipe(
      Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error))))
    )
    if (!published) {
      yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
      return yield* new BacklogError({ detail: id + " was closed by another command" })
    }
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    yield* fs.remove(paths.unreadFile(id), { force: true }).pipe(Effect.orElseSucceed(() => undefined))
    return closed
  })

const readTask = (
  root: string,
  folder: TaskFolder,
  id: string
): Effect.Effect<TaskRecord | null, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = backlogPaths(root).taskFile(folder, id)
    const text = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError(platformFailure("read " + file))
    )
    return text === null ? null : yield* parseTaskFile(file, folder, text)
  })

const readClosed = (root: string, id: string): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  readTask(root, "closed", id).pipe(
    Effect.filterOrFail((record) => record !== null, () => new BacklogError({ detail: "the backlog holds no closed " + id }))
  )

const writePosted = (root: string, id: string, postedAt: string): Effect.Effect<boolean, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const record = yield* readClosed(root, id)
    if (record.state.kind !== "closed" || record.state.postedAt !== null) {
      return false
    }
    const posted: TaskRecord = { ...record, state: { ...record.state, postedAt } }
    const file = paths.taskFile("closed", id)
    const scratch = scratchName(paths.folder("closed"), id)
    yield* fs.writeFileString(scratch, renderTaskFile(posted)).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
    return true
  })

export const markPosted = (
  root: string,
  id: string,
  postedAt: string
): Effect.Effect<boolean, BacklogError | TaskFileError, FileSystem.FileSystem> => writePosted(root, id, postedAt)

export type Rewrite<A> = { readonly kind: "write"; readonly record: TaskRecord; readonly result: A } | { readonly kind: "keep"; readonly result: A }

// rename(2) takes the one task file at most once, so a hold, an answer, a beat's claim and a park never hold the same file together.
const rewriteIn = (folder: "new" | "taken") => <A>(
  root: string,
  id: string,
  decide: (fresh: TaskRecord) => Effect.Effect<Rewrite<A>, BacklogError>
): Effect.Effect<A, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const file = paths.taskFile(folder, id)
    const grabbed = scratchName(paths.folder(folder), id)
    const took = yield* takeFile(fs, file, grabbed, id)
    if (!took) {
      return yield* new BacklogError({ detail: id + " moved while orc read it, so run the command again" })
    }
    const { putBack, read } = grabbedFile(fs, file, grabbed, id)
    const settle = Effect.gen(function*() {
      const text = yield* read
      const rewrite = yield* decide(yield* parseTaskFile(file, folder, text))
      if (rewrite.kind === "keep") {
        yield* putBack
        return { result: rewrite.result, published: false } as const
      }
      const replacement = scratchName(paths.folder(folder), id)
      const discardReplacement = fs.remove(replacement).pipe(Effect.orElseSucceed(() => undefined))
      yield* fs.writeFileString(replacement, renderTaskFile(rewrite.record)).pipe(
        Effect.mapError(platformFailure("write " + replacement)),
        Effect.catch((error) => discardReplacement.pipe(Effect.andThen(Effect.fail(error))))
      )
      yield* fs.rename(replacement, file).pipe(
        Effect.mapError(platformFailure("write " + file)),
        Effect.catch((error) => discardReplacement.pipe(Effect.andThen(Effect.fail(error))))
      )
      return { result: rewrite.result, published: true } as const
    })
    const settled = yield* settle.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    if (settled.published) {
      yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    }
    return settled.result
  })

export const rewriteNew = rewriteIn("new")

export const rewriteTaken = rewriteIn("taken")

export const findTask = (root: string, id: string): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  listTasks(root).pipe(
    Effect.map((tasks) => tasks.find((candidate) => candidate.spec.id === id)),
    Effect.filterOrFail((record) => record !== undefined, () => new BacklogError({ detail: "the backlog holds no " + id }))
  )


