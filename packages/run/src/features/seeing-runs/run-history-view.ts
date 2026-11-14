import { Effect, FileSystem, Schema } from "effect"
import { askingFileName } from "../../entities/review-gate/index"
import { RunSqlRowSchema, RunStatusSchema, RUNS_JSON_SCHEMA, type RunRecord } from "../../entities/run-history/index"
import { formatTable } from "../../shared/lib/index"
import { LatestStepSchema, type ListedRun } from "./run-facts"

const RunStateSchema = Schema.Literals(["waiting", "running", "succeeded", "failed"])
type RunState = typeof RunStateSchema.Type

const CurrentStepSchema = Schema.Struct({ name: Schema.String, attempt: Schema.Finite })
type CurrentStep = typeof CurrentStepSchema.Type

export interface RunsJsonRun extends ListedRun {
  readonly state: RunState
  readonly currentStep: CurrentStep | null
}

const readState = (run: RunRecord, runFolderOf: (runId: string) => string): Effect.Effect<RunState, never, FileSystem.FileSystem> => {
  switch (run.status) {
    case "running":
      return FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.exists(runFolderOf(run.id) + "/" + askingFileName)),
        Effect.orElseSucceed(() => false),
        Effect.map((asking): RunState => asking ? "waiting" : "running")
      )
    case "succeeded":
      return Effect.succeed("succeeded")
    case "failed":
    case "stopped":
      return Effect.succeed("failed")
  }
}

const currentStepOf = (listed: ListedRun): CurrentStep | null =>
  listed.run.status === "running" && listed.step?.status === "running"
    ? { name: listed.step.name, attempt: listed.step.attempt }
    : null

export const readRunsJsonRuns = (
  runs: ReadonlyArray<ListedRun>,
  runFolderOf: (runId: string) => string
): Effect.Effect<ReadonlyArray<RunsJsonRun>, never, FileSystem.FileSystem> =>
  Effect.forEach(runs, (listed) =>
    Effect.map(readState(listed.run, runFolderOf), (state) => ({ ...listed, state, currentStep: currentStepOf(listed) })))

const { kind, delivery, task, machine, worktree } = RunSqlRowSchema.fields

const RunJsonEntrySchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  status: RunStatusSchema,
  state: RunStateSchema,
  prLink: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  step: Schema.NullOr(LatestStepSchema),
  currentStep: Schema.NullOr(CurrentStepSchema),
  questions: Schema.Finite,
  endReason: Schema.NullOr(Schema.String),
  kind,
  delivery,
  task,
  machine,
  worktree
})

const RunsJsonSchema = Schema.Struct({
  schema: Schema.Literal(RUNS_JSON_SCHEMA),
  runs: Schema.Array(RunJsonEntrySchema)
})

export type RunsJsonDocument = typeof RunsJsonSchema.Type

export const runsJson = (runs: ReadonlyArray<RunsJsonRun>): RunsJsonDocument => ({
  schema: RUNS_JSON_SCHEMA,
  runs: runs.map(({ run, title, step, questions, state, currentStep }) => ({
    id: run.id,
    project: run.project,
    branch: run.branch,
    status: run.status,
    state,
    prLink: run.prLink,
    title,
    step,
    currentStep,
    questions,
    endReason: run.endReason,
    kind: run.kind,
    delivery: run.delivery,
    task: run.task,
    machine: run.machine,
    worktree: run.worktree
  }))
})

export const encodeRunsJson = (runs: ReadonlyArray<RunsJsonRun>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(RunsJsonSchema)(runsJson(runs)).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeRunsJson = (value: unknown): Effect.Effect<RunsJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RunsJsonSchema)(value)

export const formatRunsTable = (runs: ReadonlyArray<RunRecord>): string =>
  formatTable(["ID", "PROJECT", "BRANCH", "STATUS", "PR"], runs.map((run): ReadonlyArray<string> => [run.id, run.project, run.branch, run.status, run.prLink ?? "-"]), "no runs recorded")
