import { Effect, Schema } from "effect"
import { RunSqlRowSchema, RunStatusSchema, RUNS_JSON_SCHEMA, type RunRecord } from "../../entities/run-history/index"
import { formatTable } from "../../shared/lib/index"
import { LatestStepSchema, type ListedRun } from "./run-facts"

const { kind, delivery, task, machine, worktree } = RunSqlRowSchema.fields

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
  kind,
  delivery,
  task,
  machine,
  worktree
})

const MachineFailureSchema = Schema.Struct({
  machine: Schema.String,
  error: Schema.String
})

const RunsJsonSchema = Schema.Struct({
  schema: Schema.Literal(RUNS_JSON_SCHEMA),
  runs: Schema.Array(RunJsonEntrySchema),
  machines: Schema.Array(MachineFailureSchema)
})

export type RunsJsonDocument = typeof RunsJsonSchema.Type
export type RunsJsonRun = RunsJsonDocument["runs"][number]
export type MachineFailure = RunsJsonDocument["machines"][number]

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
    delivery: run.delivery,
    task: run.task,
    machine: run.machine,
    worktree: run.worktree
  })),
  machines: []
})

export const encodeRunsJson = (document: RunsJsonDocument): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(RunsJsonSchema)(document).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeRunsJson = (value: unknown): Effect.Effect<RunsJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RunsJsonSchema)(value)

export const formatRunsTable = (runs: ReadonlyArray<RunRecord>): string =>
  formatTable(["ID", "PROJECT", "BRANCH", "STATUS", "PR"], runs.map((run): ReadonlyArray<string> => [run.id, run.project, run.branch, run.status, run.prLink ?? "-"]), "no runs recorded")
