import { Data, Effect, FileSystem } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { TaskFileError, TaskFolder } from "./task-record"

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
    const grabbed = scratchName(paths.folder(folder), id)
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
