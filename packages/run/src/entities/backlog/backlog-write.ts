import { Data, Effect, FileSystem, Predicate } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { type TaskFileError, type TaskFolder, taskFolders } from "./task-record"

export class BacklogError extends Data.TaggedError("BacklogError")<{
  readonly detail: string
}> {}

export const platformFailure = (action: string) => (error: PlatformError): BacklogError =>
  new BacklogError({ detail: "cannot " + action + ": " + error.message })

export const backlogPresent = (root: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(root).pipe(Effect.mapError((error) => new BacklogError({ detail: "cannot read " + root + ": " + error.message })))
  })

export const noBacklog = (root: string): string => "no backlog at " + root + ": the backlog lives on the machine that runs orc beat, so run this command there"

export const readIfPresent = (file: string): Effect.Effect<string | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError(platformFailure("read " + file))
    )
  })

export const scratchName = (folder: string, id: string): string => folder + "/." + id + "." + crypto.randomUUID() + ".tmp"

// rename(2) replaces the file whole, so a reader sees one write and never a mix of two.
export const writeAtomic = (
  scratch: string,
  file: string,
  text: string
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })

// link(2) refuses an existing name, so the file appears whole and at most once.
export const publishOnce = (
  folder: string,
  name: string,
  text: string
): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const scratch = scratchName(folder, name)
    const file = folder + "/" + name
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    const published = yield* fs.link(scratch, file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.mapError(platformFailure("write " + file))
    )
    yield* fs.remove(scratch).pipe(Effect.mapError(platformFailure("remove " + scratch)))
    return published
  })

export interface BacklogPaths {
  readonly root: string
  readonly ids: string
  readonly logs: string
  readonly logFile: (id: string) => string
  readonly stallFile: (id: string) => string
  readonly unreadFile: (id: string) => string
  readonly dispatchConfig: string
  readonly projects: string
  readonly folder: (folder: TaskFolder) => string
  readonly taskFile: (folder: TaskFolder, id: string) => string
}

export const backlogRoot = (home: string): string => home + "/backlog"

export const backlogPaths = (root: string): BacklogPaths => ({
  root,
  ids: root + "/ids",
  logs: root + "/logs",
  logFile: (id: string): string => root + "/logs/" + id + ".log",
  stallFile: (id: string): string => root + "/logs/" + id + ".stall",
  unreadFile: (id: string): string => root + "/logs/" + id + ".unread",
  dispatchConfig: root + "/dispatch.json",
  projects: root + "/projects.json",
  folder: (folder: TaskFolder): string => root + "/" + folder,
  taskFile: (folder: TaskFolder, id: string): string => root + "/" + folder + "/" + id + ".md"
})

// rename(2) moves the one task file at most once, so the grab below takes it or reports it gone.
const takeFile = (fs: FileSystem.FileSystem, file: string, grabbed: string, id: string): Effect.Effect<boolean, BacklogError> =>
  fs.rename(file, grabbed).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    Effect.mapError(platformFailure("take " + id))
  )

// A failed read leaves putBack for the caller to run.
const grabbedFile = (
  fs: FileSystem.FileSystem,
  file: string,
  grabbed: string,
  id: string
): {
  readonly putBack: Effect.Effect<void, BacklogError>
  readonly read: Effect.Effect<string, BacklogError>
} => ({
  putBack: fs.rename(grabbed, file).pipe(Effect.mapError(platformFailure("put back " + id))),
  read: fs.readFileString(grabbed).pipe(Effect.mapError(platformFailure("read " + grabbed)))
})

// The owner's pid sits in the name, so a later reader can tell a grab a killed process left from one still held.
const grabName = (folder: string, id: string): string => folder + "/." + id + ".grab-" + process.pid + "-" + crypto.randomUUID() + ".tmp"

const grabPattern = /^\.(.+)\.grab-(\d+)-[0-9a-f-]+\.tmp$/

class SignalRefused extends Data.TaggedError("SignalRefused")<{
  readonly ownedByAnotherUser: boolean
}> {}

const ownerAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) => new SignalRefused({ ownedByAnotherUser: Predicate.hasProperty(error, "code") && error.code === "EPERM" })
  }).pipe(
    Effect.as(true),
    Effect.catchTag("SignalRefused", (refused) => Effect.succeed(refused.ownedByAnotherUser))
  )

export const readNames = (folder: string): Effect.Effect<ReadonlyArray<string>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readDirectory(folder).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(platformFailure("list " + folder))
    )
  })

const grabOwner = (name: string): { readonly id: string; readonly pid: number } | null => {
  const grab = grabPattern.exec(name)
  return grab === null ? null : { id: grab[1], pid: Number(grab[2]) }
}

const grabAlive = (paths: BacklogPaths, id: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    for (const folder of taskFolders) {
      for (const name of yield* readNames(paths.folder(folder))) {
        const owner = grabOwner(name)
        if (owner !== null && owner.id === id && (yield* ownerAlive(owner.pid))) {
          return true
        }
      }
    }
    return false
  })

// Only the killed owner wrote a result, so a task file in any folder is its finished result and the grab is dropped.
// link(2) refuses an existing name, so a recovery never replaces a live task file.
const recoverGrab = (fs: FileSystem.FileSystem, paths: BacklogPaths, folder: TaskFolder, grabbed: string, id: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (yield* grabAlive(paths, id)) {
      return
    }
    const results = yield* Effect.forEach(taskFolders, (each) =>
      fs.exists(paths.taskFile(each, id)).pipe(Effect.mapError(platformFailure("read " + id))))
    const dropGrab = fs.remove(grabbed).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.mapError(platformFailure("remove " + grabbed))
    )
    if (results.some(Boolean)) {
      return yield* dropGrab
    }
    const missing = yield* fs.link(grabbed, paths.taskFile(folder, id)).pipe(
      Effect.as(false),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
      Effect.mapError(platformFailure("put back " + id))
    )
    if (missing) {
      return
    }
    yield* dropGrab
  })

export const recoverGrabs = (root: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    for (const folder of taskFolders) {
      for (const name of yield* readNames(paths.folder(folder))) {
        const owner = grabOwner(name)
        if (owner !== null && !(yield* ownerAlive(owner.pid))) {
          yield* recoverGrab(fs, paths, folder, paths.folder(folder) + "/" + name, owner.id)
        }
      }
    }
  })

type Grabbed = {
  readonly fs: FileSystem.FileSystem
  readonly paths: BacklogPaths
  readonly file: string
  readonly grabbed: string
  readonly putBack: Effect.Effect<void, BacklogError>
  readonly read: Effect.Effect<string, BacklogError>
}

export const grabIn = (
  root: string,
  folder: TaskFolder,
  id: string,
  missed: Effect.Effect<never, BacklogError | TaskFileError, FileSystem.FileSystem>
): Effect.Effect<Grabbed, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const file = paths.taskFile(folder, id)
    const grabbed = grabName(paths.folder(folder), id)
    if (!(yield* takeFile(fs, file, grabbed, id))) {
      return yield* missed
    }
    return { fs, paths, file, grabbed, ...grabbedFile(fs, file, grabbed, id) }
  })

export const newGrab = (root: string, id: string): Effect.Effect<Grabbed, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  grabIn(root, "new", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" })))

export const takenGrab = (
  root: string,
  id: string,
  missed: Effect.Effect<never, BacklogError | TaskFileError, FileSystem.FileSystem>
): Effect.Effect<Grabbed, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  grabIn(root, "taken", id, missed)
