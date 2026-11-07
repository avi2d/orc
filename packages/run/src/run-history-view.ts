import { Effect, Schema } from "effect"
import { RunStatusSchema, RUNS_JSON_SCHEMA, type RunRecord } from "./run-history"

const RunJsonEntrySchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  status: RunStatusSchema,
  prLink: Schema.NullOr(Schema.String)
})

const RunsJsonSchema = Schema.Struct({
  schema: Schema.Literal(RUNS_JSON_SCHEMA),
  runs: Schema.Array(RunJsonEntrySchema)
})

export type RunsJsonDocument = typeof RunsJsonSchema.Type

export const runsJson = (runs: ReadonlyArray<RunRecord>): RunsJsonDocument => ({
  schema: RUNS_JSON_SCHEMA,
  runs: runs.map((run) => ({
    id: run.id,
    project: run.project,
    branch: run.branch,
    status: run.status,
    prLink: run.prLink
  }))
})

export const encodeRunsJson = (runs: ReadonlyArray<RunRecord>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(RunsJsonSchema)(runsJson(runs)).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeRunsJson = (value: unknown): Effect.Effect<RunsJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RunsJsonSchema)(value)

export const formatRunsTable = (runs: ReadonlyArray<RunRecord>): string => {
  if (runs.length === 0) {
    return "no runs recorded"
  }
  const header: ReadonlyArray<string> = ["ID", "PROJECT", "BRANCH", "STATUS", "PR"]
  const body = runs.map((run): ReadonlyArray<string> => [run.id, run.project, run.branch, run.status, run.prLink ?? "-"])
  const table: ReadonlyArray<ReadonlyArray<string>> = [header, ...body]
  const widths: Array<number> = []
  for (const row of table) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return table.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd())
    .join("\n")
}
