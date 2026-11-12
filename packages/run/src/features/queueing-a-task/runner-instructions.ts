import { Effect, FileSystem, Path, Schema } from "effect"
import { readFailure } from "../../shared/config/index"
import { RunnerError } from "../../shared/process/index"

export const TaskInstructions = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^(?!\.\.?$)[^/]+$/)),
  text: Schema.String
})
type TaskInstructions = typeof TaskInstructions.Type

export const readInstructions = (file: string): Effect.Effect<{ readonly instructions?: TaskInstructions }, RunnerError, FileSystem.FileSystem | Path.Path> =>
  file === ""
    ? Effect.succeed({})
    : Effect.all([FileSystem.FileSystem, Path.Path]).pipe(
      Effect.flatMap(([fs, path]) => fs.readFileString(file).pipe(Effect.map((text) => ({ instructions: { name: path.basename(file), text } })))),
      Effect.mapError((error) => new RunnerError({ detail: "cannot read the instructions file " + file + ": " + readFailure(error) }))
    )

export const writeInstructions = (folder: string, instructions: TaskInstructions): Effect.Effect<string, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = folder + "/" + instructions.name
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(file, instructions.text)),
      Effect.mapError((error) => new RunnerError({ detail: "cannot write " + file + ": " + error.message }))
    )
    return file
  })
