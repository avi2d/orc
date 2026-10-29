import { Data, Effect, FileSystem, Schema } from "effect"
import type { ParseOptions } from "effect/SchemaAST"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly file: string
  readonly detail: string
}> {}

export const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//))

export const duplicateOf = (names: ReadonlyArray<string>): string | null =>
  names.find((name, index) => names.indexOf(name) !== index) ?? null

const readTextIfPresent = (file: string): Effect.Effect<string | null, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string | null>(null)),
      Effect.mapError((error) => new ConfigError({ file, detail: error.message }))
    )
  })

const decodeJsonText = <S extends Schema.Top>(
  file: string,
  text: string,
  schema: S,
  options: ParseOptions | undefined
): Effect.Effect<S["Type"], ConfigError, S["DecodingServices"]> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new ConfigError({ file, detail: "the file is no JSON" })
  }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(schema)(raw, options).pipe(
      Effect.mapError((error) => new ConfigError({ file, detail: error.message }))
    ))
  )

export const readJsonFile = <S extends Schema.Top>(
  file: string,
  schema: S,
  options?: ParseOptions
): Effect.Effect<S["Type"], ConfigError, FileSystem.FileSystem | S["DecodingServices"]> =>
  readTextIfPresent(file).pipe(
    Effect.flatMap((text) => text === null
      ? Effect.fail(new ConfigError({ file, detail: "the file is missing" }))
      : decodeJsonText(file, text, schema, options))
  )

export const readJsonFileIfPresent = <S extends Schema.Top>(
  file: string,
  schema: S,
  options?: ParseOptions
): Effect.Effect<S["Type"] | null, ConfigError, FileSystem.FileSystem | S["DecodingServices"]> =>
  readTextIfPresent(file).pipe(
    Effect.flatMap((text) => text === null ? Effect.succeed(null) : decodeJsonText(file, text, schema, options))
  )
