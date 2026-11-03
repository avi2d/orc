import { Effect, FileSystem, Schema } from "effect"
import { BacklogError, platformFailure, publishOnce } from "./backlog-write"

export interface ChatEvent {
  readonly key: string
  readonly at: string
  readonly text: string
}

const keyPattern = /^[a-z0-9][a-z0-9.-]*$/

export const isEventKey = (key: string): boolean => keyPattern.test(key) && key.includes(".")

const EventFile = Schema.fromJsonString(Schema.Struct({ at: Schema.String, text: Schema.String }))

const eventsFolder = (root: string): string => root + "/events"
const postedFolder = (root: string): string => root + "/events/posted"

const fileSuffix = ".json"

// The key names the file, and link(2) refuses an existing name, so each event is recorded at most once however often a beat sees it.
export const recordEvent = (root: string, event: ChatEvent): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = eventsFolder(root)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    const text = yield* Schema.encodeEffect(EventFile)({ at: event.at, text: event.text }).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot write the event " + event.key + ": " + error.message }))
    )
    return yield* publishOnce(folder, event.key + fileSuffix, text)
  })

export const eventRecorded = (root: string, key: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(eventsFolder(root) + "/" + key + fileSuffix).pipe(Effect.mapError(platformFailure("read " + key)))
  })

export const markEventPosted = (root: string, key: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* eventRecorded(root, key))) {
      return yield* new BacklogError({ detail: "the backlog holds no event " + key })
    }
    const folder = postedFolder(root)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    return yield* publishOnce(folder, key, "")
  })

const namesIn = (folder: string): Effect.Effect<ReadonlyArray<string>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readDirectory(folder).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(platformFailure("list " + folder))
    )
  })

const readEvent = (root: string, key: string): Effect.Effect<ChatEvent, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = eventsFolder(root) + "/" + key + fileSuffix
    const text = yield* fs.readFileString(file).pipe(Effect.mapError(platformFailure("read " + file)))
    const decoded = yield* Schema.decodeEffect(EventFile)(text).pipe(
      Effect.mapError((error) => new BacklogError({ detail: file + " holds no event orc reads: " + error.message }))
    )
    return { key, ...decoded }
  })

export const unpostedEvents = (root: string): Effect.Effect<ReadonlyArray<ChatEvent>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const posted = new Set(yield* namesIn(postedFolder(root)))
    const keys = (yield* namesIn(eventsFolder(root)))
      .filter((name) => name.endsWith(fileSuffix))
      .map((name) => name.slice(0, -fileSuffix.length))
      .filter((key) => isEventKey(key) && !posted.has(key))
    const events = yield* Effect.forEach(keys, (key) => readEvent(root, key))
    return events.toSorted((left, right) => left.at.localeCompare(right.at) || left.key.localeCompare(right.key))
  })
