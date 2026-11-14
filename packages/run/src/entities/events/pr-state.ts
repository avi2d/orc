import { Effect, FileSystem, Schema } from "effect"
import { BacklogError, platformFailure, readIfPresent, scratchName } from "../backlog/index"

const PrState = Schema.Literals(["open", "closed", "merged"])
export type PrState = typeof PrState.Type
const PrReading = Schema.fromJsonString(Schema.Struct({ pr: Schema.String, state: PrState }))

export const readPrState = (root: string, id: string, pr: string): Effect.Effect<PrState | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = root + "/pr-state/" + id + ".json"
    const text = yield* readIfPresent(file)
    if (text === null) return null
    const reading = yield* Schema.decodeEffect(PrReading)(text).pipe(
      Effect.mapError((error) => new BacklogError({ detail: file + " holds no PR state orc reads: " + error.message }))
    )
    return reading.pr === pr ? reading.state : null
  })

export const writePrState = (root: string, id: string, pr: string, state: PrState): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = root + "/pr-state"
    const file = folder + "/" + id + ".json"
    const scratch = scratchName(folder, id)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    const text = yield* Schema.encodeEffect(PrReading)({ pr, state }).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot write " + file + ": " + error.message }))
    )
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })
