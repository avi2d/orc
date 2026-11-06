import { Effect, FileSystem, Schema } from "effect"
import { captainWait, type Hold, type ParkedQuestion, parseTaskFile, renderTaskFile, type TaskFileError, type TaskFolder, taskFolders, type TaskRecord, type TaskSpec } from "./task-record"
import { BacklogError, platformFailure, publishOnce, scratchName } from "./backlog-write"

export { BacklogError }

// A project name may hold dashes, so an id splits at its last dash.
const idPattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+)$/
const taskFilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*-\d+\.md$/

const splitId = (id: string): { readonly project: string; readonly number: number } | null => {
  const split = idPattern.exec(id)
  return split === null ? null : { project: split[1], number: Number(split[2]) }
}

export const isTaskId = (id: string): boolean => idPattern.test(id)

export const TaskId = Schema.String.check(Schema.isPattern(idPattern))

interface BacklogPaths {
  readonly root: string
  readonly ids: string
  readonly logs: string
  readonly logFile: (id: string) => string
  readonly stallFile: (id: string) => string
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
  stallFile: (id: string): string => root + "/logs/" + id + ".stall",
  dispatchConfig: root + "/dispatch.json",
  projects: root + "/projects.json",
  folder: (folder: TaskFolder): string => root + "/" + folder,
  taskFile: (folder: TaskFolder, id: string): string => root + "/" + folder + "/" + id + ".md"
})

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

export const closeStartedTask = (
  root: string,
  id: string,
  outcome: "done" | "failed",
  reason: string,
  delivered: { readonly pr: string | null; readonly report: string | null },
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
      ...record,
      state: { kind: "closed", claim: record.state.claim, closing: { outcome, started: record.state.started, reason, ...delivered }, closedAt, postedAt: null }
    }
    if (!(yield* publishClosed(root, closed))) {
      return yield* new BacklogError({ detail: id + " was closed by another command" })
    }
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

// rename(2) takes the one task file at most once, so a hold, an answer and a beat's claim never hold the same file together.
export const rewriteNew = <A>(
  root: string,
  id: string,
  decide: (fresh: TaskRecord) => Effect.Effect<Rewrite<A>, BacklogError>
): Effect.Effect<A, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const file = paths.taskFile("new", id)
    const grabbed = scratchName(paths.folder("new"), id)
    const took = yield* fs.rename(file, grabbed).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.mapError(platformFailure("take " + id))
    )
    if (!took) {
      return yield* new BacklogError({ detail: id + " moved while orc read it, so run the command again" })
    }
    const putBack = fs.rename(grabbed, file).pipe(Effect.mapError(platformFailure("put back " + id)))
    const settle = Effect.gen(function*() {
      const text = yield* fs.readFileString(grabbed).pipe(Effect.mapError(platformFailure("read " + grabbed)))
      const rewrite = yield* decide(yield* parseTaskFile(file, "new", text))
      if (rewrite.kind === "keep") {
        yield* putBack
        return { result: rewrite.result, published: false } as const
      }
      const replacement = scratchName(paths.folder("new"), id)
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

export const findTask = (root: string, id: string): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  listTasks(root).pipe(
    Effect.map((tasks) => tasks.find((candidate) => candidate.spec.id === id)),
    Effect.filterOrFail((record) => record !== undefined, () => new BacklogError({ detail: "the backlog holds no " + id }))
  )

export type HoldOutcome = { readonly kind: "held" | "already held"; readonly hold: Hold }

export interface HoldAsk {
  readonly reason: string
  readonly until: string | null
  readonly questions: ReadonlyArray<string>
}

const askedQuestions = (texts: ReadonlyArray<string>): ReadonlyArray<ParkedQuestion> =>
  texts.map((text, index) => ({ id: "question-" + String(index + 1), text, answer: null }))

const asksTheSame = (held: ReadonlyArray<ParkedQuestion>, texts: ReadonlyArray<string>): boolean =>
  held.length === texts.length && held.every((question, index) => question.text === texts[index])

const holdAgain = (id: string, fresh: TaskRecord, held: Hold, ask: HoldAsk): Effect.Effect<Rewrite<HoldOutcome>, BacklogError> => {
  if (ask.questions.length === 0 || asksTheSame(held.questions, ask.questions)) {
    return Effect.succeed({ kind: "keep", result: { kind: "already held", hold: held } })
  }
  if (held.questions.length > 0) {
    return Effect.fail(new BacklogError({ detail: id + " is already held on " + held.questions.map((question) => question.id).join(", ") + ", so answer those first" }))
  }
  return Effect.fail(new BacklogError({ detail: id + " is already held: " + held.reason + ", so answer it first" }))
}

const holdOn = (id: string, ask: HoldAsk) => (fresh: TaskRecord): Effect.Effect<Rewrite<HoldOutcome>, BacklogError> => {
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " is " + fresh.state.kind + ", and only a new task is held" }))
  }
  if (fresh.parked !== null) {
    return Effect.fail(new BacklogError({ detail: id + " is parked for the captain's answer, so it cannot be held" }))
  }
  if (fresh.hold?.answer != null) {
    return Effect.fail(new BacklogError({ detail: id + " was held and answered: " + fresh.hold.answer.words }))
  }
  if (fresh.hold !== null) {
    return holdAgain(id, fresh, fresh.hold, ask)
  }
  const held: Hold = { reason: ask.reason, until: ask.until, questions: askedQuestions(ask.questions), answer: null }
  return Effect.succeed({ kind: "write", record: { ...fresh, hold: held }, result: { kind: "held", hold: held } })
}

// A taken task belongs to a live beat that goes on writing its taken file, so only a new one is rewritten.
export const holdTask = (
  root: string,
  id: string,
  ask: HoldAsk
): Effect.Effect<HoldOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decide = holdOn(id, ask)
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })
