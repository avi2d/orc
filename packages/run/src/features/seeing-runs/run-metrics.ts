import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { listAllRuns, RunStatusSchema, type RunRecord, type SqliteFailure } from "../../entities/run-history/index"
import { formatTable } from "../../shared/lib/index"
import { readShow, type ShowJsonDocument } from "./show"

const METRICS_JSON_SCHEMA = "orc.metrics.v2" as const

const GateStopsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const decodeGatesAnswered = Schema.decodeUnknownEffect(Schema.fromJsonString(GateStopsSchema))

const RunMetricsSchema = Schema.Struct({
  run: Schema.String,
  task: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  status: RunStatusSchema,
  failedSteps: Schema.Int,
  gateStops: GateStopsSchema,
  minutes: Schema.NullOr(Schema.Finite),
  fixRounds: Schema.Int
})

type RunMetrics = typeof RunMetricsSchema.Type

const MetricsJsonSchema = Schema.Struct({
  schema: Schema.Literal(METRICS_JSON_SCHEMA),
  runs: Schema.Array(RunMetricsSchema)
})

type ShowStep = ShowJsonDocument["steps"][number]

const minutesOf = (started: string, ended: string | null): number | null => {
  if (ended === null) {
    return null
  }
  const millis = Date.parse(ended) - Date.parse(started)
  return Number.isFinite(millis) ? Math.round(millis / 6000) / 10 : null
}

const metricsOf = (run: RunRecord, steps: ReadonlyArray<ShowStep>): Effect.Effect<RunMetrics, Schema.SchemaError> =>
  Effect.gen(function*() {
    const own = steps.filter((step) => step.from === null)
    let gateStops = own.filter((step) => step.name === "checks" && step.status === "failed").length
    for (const step of own.filter((candidate) => candidate.name === "no-mistakes")) {
      const answered = step.signals.findLast((signal) => signal.name === "gates-answered")
      if (answered !== undefined) {
        gateStops += yield* decodeGatesAnswered(answered.value)
      }
    }
    const last = own.at(-1)
    if (run.status !== "running" && last?.name === "no-mistakes" && last.status === "failed" && last.signals.some((signal) => signal.name === "gate" && signal.value !== "")) {
      gateStops += 1
    }
    return {
      run: run.id,
      task: run.task,
      delivery: run.delivery,
      status: run.status,
      failedSteps: own.filter((step) => step.status === "failed").length,
      gateStops,
      minutes: minutesOf(run.started, run.ended),
      fixRounds: own.filter((step) => step.name === "fix").length
    }
  })

export const readRunMetrics = (db: Database): Effect.Effect<ReadonlyArray<RunMetrics>, Schema.SchemaError | SqliteFailure> =>
  listAllRuns(db).pipe(
    Effect.flatMap((runs) =>
      Effect.forEach(runs, (run) => readShow(db, run.id).pipe(Effect.flatMap((document) => metricsOf(run, document?.steps ?? []))))
    )
  )

export const encodeMetricsJson = (runs: ReadonlyArray<RunMetrics>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(MetricsJsonSchema)({ schema: METRICS_JSON_SCHEMA, runs }).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeMetricsJson = (value: unknown): Effect.Effect<typeof MetricsJsonSchema.Type, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(MetricsJsonSchema)(value)

export const formatMetricsTable = (runs: ReadonlyArray<RunMetrics>): string =>
  formatTable(
    ["RUN", "TASK", "DELIVERY", "STATUS", "FAILED STEPS", "GATE STOPS", "MINUTES", "FIX ROUNDS"],
    runs.map((metrics): ReadonlyArray<string> => [
      metrics.run,
      metrics.task ?? "-",
      metrics.delivery ?? "-",
      metrics.status,
      metrics.failedSteps.toString(),
      metrics.gateStops.toString(),
      metrics.minutes === null ? "-" : metrics.minutes.toFixed(1),
      metrics.fixRounds.toString()
    ]),
    "no runs recorded"
  )
