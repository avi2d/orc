import { Effect, FileSystem, Schema } from "effect"
import { BacklogError, platformFailure, readIfPresent } from "./backlog-write"

const NoteLine = Schema.fromJsonString(Schema.Struct({ at: Schema.String, who: Schema.String, text: Schema.String }))

export type TaskNote = typeof NoteLine.Type

const notesFolder = (root: string): string => root + "/notes"

const notesFile = (root: string, id: string): string => notesFolder(root) + "/" + id + ".jsonl"

// O_APPEND places each write at the file's end, so a note sent in one write never interleaves with another writer's line.
export const appendNote = (root: string, id: string, note: TaskNote): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = notesFolder(root)
    const file = notesFile(root, id)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    const line = yield* Schema.encodeEffect(NoteLine)(note).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot write a note on " + id + ": " + error.message }))
    )
    const bytes = new TextEncoder().encode(line + "\n")
    yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* fs.open(file, { flag: "a" }).pipe(Effect.mapError(platformFailure("append to " + file)))
        const written = yield* handle.write(bytes).pipe(Effect.mapError(platformFailure("append to " + file)))
        if (written !== bytes.length) {
          return yield* Effect.fail(
            new BacklogError({ detail: "cannot append to " + file + ": wrote " + String(written) + " of " + String(bytes.length) + " bytes" })
          )
        }
      })
    )
  })

export const readNotes = (root: string, id: string): Effect.Effect<ReadonlyArray<TaskNote>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = notesFile(root, id)
    const text = yield* readIfPresent(file)
    const lines = (text ?? "").split("\n").filter((line) => line !== "")
    return yield* Effect.forEach(lines, (line, index) =>
      Schema.decodeEffect(NoteLine)(line).pipe(
        Effect.mapError((error) => new BacklogError({ detail: file + " line " + String(index + 1) + " is no note: " + error.message }))
      ))
  })
