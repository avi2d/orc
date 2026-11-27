import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { listAllRuns, RunStatusSchema, type RunRecord, type SqliteFailure } from "../../entities/run-history/index"
import { formatTable } from "../../shared/lib/index"
import { readShow, type ShowJsonDocument } from "./show"

const METRICS_JSON_SCHEMA = "orc.metrics.v1" as const

const RunMetricsSchema = Schema.Struct({
  run: Schema.String,
  task: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  status: RunStatusSchema,
  failedSteps: Schema.Int,
  gateStop: Schema.NullOr(Schema.String),
  minutes: Schema.NullOr(Schema.Finite),
  fixRounds: Schema.Int
})

type RunMetrics = typeof RunMetricsSchema.Type

const MetricsJsonSchema = Schema.Struct({
  schema: Schema.Literal(METRICS_JSON_SCHEMA),
  runs: Schema.Array(RunMetricsSchema)
})

type ShowStep = ShowJsonDocument["steps"][number]

const failedCheckNames = (step: ShowStep): ReadonlyArray<string> =>
  step.signals.filter((signal) => signal.name.startsWith("check ") && signal.value === "failed").map((signal) => signal.name.slice("check ".length))

const gateDetail = (step: ShowStep): ReadonlyArray<string> => {
  if (step.name === "checks") {
    return failedCheckNames(step)
  }
  if (step.name === "no-mistakes") {
    return step.signals.filter((signal) => signal.name === "gate").map((signal) => signal.value).slice(-1)
  }
  return []
}

// A failed step a later step follows was passed by a fix or a retry, so only the last step can be where the run stopped.
const gateStopOf = (status: RunRecord["status"], own: ReadonlyArray<ShowStep>): string | null => {
  const last = own.at(-1)
  if (status === "running" || last?.status !== "failed") {
    return null
  }
  const detail = gateDetail(last)
  return detail.length === 0 ? last.name : last.name + ": " + detail.join(", ")
}

const minutesOf = (started: string, ended: string | null): number | null => {
  if (ended === null) {
    return null
  }
  const millis = Date.parse(ended) - Date.parse(started)
  return Number.isFinite(millis) ? Math.round(millis / 6000) / 10 : null
}

// A resumed run carries its earlier run's steps, and counting them here would count them again for every resume.
const metricsOf = (run: RunRecord, steps: ReadonlyArray<ShowStep>): RunMetrics => {
  const own = steps.filter((step) => step.from === null)
  return {
    run: run.id,
    task: run.task,
    delivery: run.delivery,
    status: run.status,
    failedSteps: own.filter((step) => step.status === "failed").length,
    gateStop: gateStopOf(run.status, own),
    minutes: minutesOf(run.started, run.ended),
    fixRounds: own.filter((step) => step.name === "fix").length
  }
}

export const readRunMetrics = (db: Database): Effect.Effect<ReadonlyArray<RunMetrics>, Schema.SchemaError | SqliteFailure> =>
  listAllRuns(db).pipe(
    Effect.flatMap((runs) =>
      Effect.forEach(runs, (run) => readShow(db, run.id).pipe(Effect.map((document) => metricsOf(run, document?.steps ?? []))))
    )
  )

export const encodeMetricsJson = (runs: ReadonlyArray<RunMetrics>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(MetricsJsonSchema)({ schema: METRICS_JSON_SCHEMA, runs }).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeMetricsJson = (value: unknown): Effect.Effect<typeof MetricsJsonSchema.Type, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(MetricsJsonSchema)(value)

export const formatMetricsTable = (runs: ReadonlyArray<RunMetrics>): string =>
  formatTable(
    ["RUN", "TASK", "DELIVERY", "STATUS", "FAILED STEPS", "GATE STOP", "MINUTES", "FIX ROUNDS"],
    runs.map((metrics): ReadonlyArray<string> => [
      metrics.run,
      metrics.task ?? "-",
      metrics.delivery ?? "-",
      metrics.status,
      metrics.failedSteps.toString(),
      metrics.gateStop ?? "-",
      metrics.minutes === null ? "-" : metrics.minutes.toFixed(1),
      metrics.fixRounds.toString()
    ]),
    "no runs recorded"
  )
