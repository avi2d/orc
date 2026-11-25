import { Schema } from "effect"

export const UPDATE_JSON_SCHEMA = "orc.update.v1"

export const UpdateDocument = Schema.Union([
  Schema.Struct({
    schema: Schema.Literal(UPDATE_JSON_SCHEMA),
    found: Schema.String,
    running: Schema.String,
    outcome: Schema.Literal("installed"),
    detail: Schema.Null,
    output: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    schema: Schema.Literal(UPDATE_JSON_SCHEMA),
    found: Schema.String,
    running: Schema.String,
    outcome: Schema.Literal("current"),
    detail: Schema.Null,
    output: Schema.Null
  }),
  Schema.Struct({
    schema: Schema.Literal(UPDATE_JSON_SCHEMA),
    found: Schema.NullOr(Schema.String),
    running: Schema.String,
    outcome: Schema.Literal("failed"),
    detail: Schema.String,
    output: Schema.NullOr(Schema.String),
    retryable: Schema.optionalKey(Schema.Literal(false))
  })
])

export type UpdateDocument = typeof UpdateDocument.Type

export const UpdateJson = Schema.fromJsonString(UpdateDocument)

export const stableVersion = /^\d+\.\d+\.\d+$/

export const isNewer = (found: string, running: string): boolean => Bun.semver.order(found, running) === 1

export const installerError = (update: Pick<Extract<UpdateDocument, { outcome: "failed" }>, "detail" | "output">): string =>
  update.output ? update.detail + "\n" + update.output : update.detail
