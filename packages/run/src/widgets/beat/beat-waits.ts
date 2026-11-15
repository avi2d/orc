import { Effect, FileSystem, Schema } from "effect"
import { BacklogError, type DeciderOwns, platformFailure, readIfPresent, scratchName, type TaskRecord } from "../../entities/backlog/index"
import type { BeatAction } from "../../entities/attention/index"
import { taskWait } from "./beat-place"

const BeatWait = Schema.Struct({ task: Schema.String, reason: Schema.String })
type BeatWait = typeof BeatWait.Type

const BeatWaitsFile = Schema.fromJsonString(Schema.Struct({ at: Schema.String, waits: Schema.Array(BeatWait) }))

export type BeatWaits = Pick<typeof BeatWaitsFile.Type, "at"> & { readonly reasons: ReadonlyMap<string, string> }

const beatWaitsFile = (root: string): string => root + "/waits.json"

export const readBeatWaits = (root: string): Effect.Effect<BeatWaits | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = beatWaitsFile(root)
    const text = yield* readIfPresent(file)
    if (text === null) {
      return null
    }
    const reading = yield* Schema.decodeEffect(BeatWaitsFile)(text).pipe(
      Effect.mapError((error) => new BacklogError({ detail: file + " holds no beat waits orc reads: " + error.message }))
    )
    return { at: reading.at, reasons: new Map(reading.waits.map((wait) => [wait.task, wait.reason] as const)) }
  })

// rename(2) replaces the file whole, so a reader sees one beat's waits and never a mix of two.
export const writeBeatWaits = (root: string, at: string, waits: ReadonlyArray<BeatWait>): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = beatWaitsFile(root)
    const scratch = scratchName(root, "waits")
    const text = yield* Schema.encodeEffect(BeatWaitsFile)({ at, waits }).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot write " + file + ": " + error.message }))
    )
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })

export const roomWaits = (
  queued: ReadonlyArray<TaskRecord>,
  actions: ReadonlyArray<BeatAction>,
  tasks: ReadonlyArray<TaskRecord>,
  merged: ReadonlySet<string>,
  deciderOwns: DeciderOwns
): ReadonlyArray<BeatWait> =>
  actions.flatMap((action) => {
    if (action.kind !== "waits") {
      return []
    }
    const task = queued.find((candidate) => candidate.spec.id === action.task)
    return task !== undefined && taskWait(task, tasks, merged, deciderOwns) === null ? [{ task: action.task, reason: action.reason }] : []
  })
