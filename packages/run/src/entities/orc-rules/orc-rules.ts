import { Data, Effect, FileSystem, type Path } from "effect"
import { type ProjectInstructions, readFailure, readProjectInstructions } from "../../shared/config/index"

export class RulesError extends Data.TaggedError("RulesError")<{
  readonly message: string
}> {}

export type OrcRules = { readonly kind: "loaded"; readonly file: string; readonly text: string } | { readonly kind: "none"; readonly file: string }

export const readOrcRules = (orcHome: string): Effect.Effect<OrcRules, RulesError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = orcHome + "/orchestrator.md"
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError((error) => new RulesError({ message: file + ": " + error.message }))
    )
    if (info === null || info.type !== "File") {
      return { kind: "none", file }
    }
    const text = yield* fs.readFileString(file).pipe(Effect.mapError((error) => new RulesError({ message: file + ": " + readFailure(error) })))
    return { kind: "loaded", file, text }
  })

export interface LoadedInstructions extends ProjectInstructions {
  readonly text: string
}

export const readInstructions = (projectsFile: string, project?: string): Effect.Effect<ReadonlyArray<LoadedInstructions>, RulesError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const named = yield* readProjectInstructions(projectsFile).pipe(
      Effect.mapError((error) => new RulesError({ message: error.file + ": " + error.detail }))
    )
    return yield* Effect.forEach(named.filter((entry) => project === undefined || entry.project === project), (entry) =>
      fs.readFileString(entry.file).pipe(
        Effect.map((text) => ({ ...entry, text })),
        Effect.mapError((error) => new RulesError({ message: "cannot read the instructions file " + entry.file + ": " + readFailure(error) }))
      ))
  })
