import { Effect, Schema } from "effect"
import { RunStatusSchema, RUNS_JSON_SCHEMA, type RunRecord } from "../../entities/run-history/index"
import { formatTable } from "../../shared/lib/index"
import { LatestStepSchema, type ListedRun } from "./run-facts"

const RunJsonEntrySchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  status: RunStatusSchema,
  prLink: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  step: Schema.NullOr(LatestStepSchema),
  questions: Schema.Finite,
  endReason: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String)
})

const RunsJsonSchema = Schema.Struct({
  schema: Schema.Literal(RUNS_JSON_SCHEMA),
  runs: Schema.Array(RunJsonEntrySchema)
})

export type RunsJsonDocument = typeof RunsJsonSchema.Type

export const runsJson = (runs: ReadonlyArray<ListedRun>): RunsJsonDocument => ({
  schema: RUNS_JSON_SCHEMA,
  runs: runs.map(({ run, title, step, questions }) => ({
    id: run.id,
    project: run.project,
    branch: run.branch,
    status: run.status,
    prLink: run.prLink,
    title,
    step,
    questions,
    endReason: run.endReason,
    kind: run.kind,
    delivery: run.delivery
  }))
})

export const encodeRunsJson = (runs: ReadonlyArray<ListedRun>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(RunsJsonSchema)(runsJson(runs)).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeRunsJson = (value: unknown): Effect.Effect<RunsJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RunsJsonSchema)(value)

export const formatRunsTable = (runs: ReadonlyArray<RunRecord>): string =>
  formatTable(["ID", "PROJECT", "BRANCH", "STATUS", "PR"], runs.map((run): ReadonlyArray<string> => [run.id, run.project, run.branch, run.status, run.prLink ?? "-"]), "no runs recorded")
