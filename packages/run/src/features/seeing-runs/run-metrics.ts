import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { listAllRuns, RunStatusSchema, type RunRecord, type SqliteFailure } from "../../entities/run-history/index"
import { formatTable } from "../../shared/lib/index"
import { readShow, type ShowJsonDocument } from "./show"

const METRICS_JSON_SCHEMA = "orc.metrics.v1" as const

const GateStopsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const decodeCount = Schema.decodeUnknownEffect(Schema.fromJsonString(GateStopsSchema))

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

const signalOf = (step: ShowStep, name: string): string | undefined => step.signals.findLast((signal) => signal.name === name)?.value

// A step recorded before the gate-stops signal holds only its answered gates and its final gate.
const noMistakesStops = (run: RunRecord, step: ShowStep, isLast: boolean): Effect.Effect<number, Schema.SchemaError> => {
  const stops = signalOf(step, "gate-stops")
  if (stops !== undefined) {
    return decodeCount(stops)
  }
  const answered = signalOf(step, "gates-answered")
  const parkedAtEnd = isLast && run.status !== "running" && step.status === "failed" && (signalOf(step, "gate") ?? "") !== "" ? 1 : 0
  return answered === undefined ? Effect.succeed(parkedAtEnd) : decodeCount(answered).pipe(Effect.map((count) => count + parkedAtEnd))
}

const gateStopsOf = (run: RunRecord, own: ReadonlyArray<ShowStep>): Effect.Effect<number, Schema.SchemaError> =>
  Effect.gen(function*() {
    let stops = own.filter((step) => step.name === "checks" && step.status === "failed").length
    for (const [index, step] of own.entries()) {
      if (step.name === "review" && run.delivery === "orc" && (step.status === "failed" || (step.status === "passed" && own[index + 1]?.name === "fix"))) {
        stops += 1
      }
      if (step.name === "no-mistakes") {
        stops += yield* noMistakesStops(run, step, index === own.length - 1)
      }
    }
    return stops
  })

const metricsOf = (run: RunRecord, steps: ReadonlyArray<ShowStep>): Effect.Effect<RunMetrics, Schema.SchemaError> =>
  Effect.gen(function*() {
    const own = steps.filter((step) => step.from === null)
    const gateStops = yield* gateStopsOf(run, own)
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
