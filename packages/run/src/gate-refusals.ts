import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { sqlite, type SqliteFailure } from "./run-history"
import { formatTable } from "./shared/lib/index"

export const GateRefusalSchema = Schema.Struct({ gate: Schema.String, rule: Schema.NullOr(Schema.String) })

export type GateRefusal = typeof GateRefusalSchema.Type

const shortGate = (gate: string): string =>
  gate.startsWith("checks-") ? gate.slice("checks-".length) : gate

const summaryGates = (text: string): ReadonlyArray<string> => {
  const gates: Array<string> = []
  for (const line of text.split("\n")) {
    const bins = /^(?:\S+): \d+ of \d+ gate\(s\) (?:failed|undecided): (.+)$/.exec(line.trim())?.[1]
    if (bins === undefined) {
      continue
    }
    for (const bin of bins.split(",")) {
      const gate = shortGate(bin.trim())
      if (gate !== "" && !gates.includes(gate)) {
        gates.push(gate)
      }
    }
  }
  return gates
}

const stableRules = (output: string): ReadonlyArray<string> => {
  const rules: Array<string> = []
  for (const line of output.split("\n")) {
    const tool = /^\S+:\d+:\d+: error ([A-Za-z][\w-]*\([^()\s]+\))/.exec(line)?.[1]
      ?? /^(?:\S+\(\d+,\d+\): )?error (TS\d+):/.exec(line)?.[1]
    if (tool !== undefined && !rules.includes(tool)) {
      rules.push(tool)
    }
  }
  return rules
}

export const refusalsIn = (output: string, check: string): ReadonlyArray<GateRefusal> => {
  const refusals: Array<GateRefusal> = []
  const keep = (gate: string, rule: string | null): void => {
    refusals.push({ gate, rule })
  }
  for (const bin of summaryGates(output)) {
    keep(bin, null)
  }
  for (const rule of stableRules(output)) {
    keep(check, rule)
  }
  if (refusals.length === 0) {
    keep(check, null)
  }
  return refusals
}

export const distinctRefusals = (refusals: ReadonlyArray<GateRefusal>): ReadonlyArray<GateRefusal> =>
  refusals.filter((refusal, index, all) =>
    all.findIndex((other) => other.gate === refusal.gate && (other.rule ?? "") === (refusal.rule ?? "")) === index
  )

export const refusalValue = (refusal: GateRefusal): string =>
  JSON.stringify({ gate: refusal.gate, rule: refusal.rule })

export const refusalSignalName = "refusal"

const RefusalCountSchema = Schema.Struct({
  gate: Schema.String,
  rule: Schema.NullOr(Schema.String),
  runs: Schema.Finite
})

export type RefusalCount = typeof RefusalCountSchema.Type

const REFUSALS_JSON_SCHEMA = "orc.refusals.v1" as const

const RefusalsJsonSchema = Schema.Struct({
  schema: Schema.Literal(REFUSALS_JSON_SCHEMA),
  refusals: Schema.Array(RefusalCountSchema)
})

export type RefusalsJsonDocument = typeof RefusalsJsonSchema.Type

export const refusalsJson = (counts: ReadonlyArray<RefusalCount>): RefusalsJsonDocument => ({
  schema: REFUSALS_JSON_SCHEMA,
  refusals: counts.map((count) => ({ gate: count.gate, rule: count.rule, runs: count.runs }))
})

export const encodeRefusalsJson = (counts: ReadonlyArray<RefusalCount>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(RefusalsJsonSchema)(refusalsJson(counts)).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeRefusalsJson = (value: unknown): Effect.Effect<RefusalsJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RefusalsJsonSchema)(value)

const RefusalRowSchema = Schema.Struct({
  run_id: Schema.String,
  value: Schema.fromJsonString(GateRefusalSchema)
})

export const readRefusals = (
  db: Database
): Effect.Effect<ReadonlyArray<RefusalCount>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query(
      "SELECT steps.run_id AS run_id, signals.value AS value FROM signals JOIN steps ON signals.step_id = steps.id WHERE signals.name = ? AND steps.name = ? ORDER BY steps.started ASC, steps.id ASC"
    ).all(refusalSignalName, "checks")
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RefusalRowSchema))),
    Effect.map((rows) => {
      const runsByRefusal = new Map<string, { readonly gate: string; readonly rule: string | null; readonly runs: Set<string> }>()
      for (const row of rows) {
        const key = row.value.gate + "\0" + (row.value.rule ?? "")
        const entry = runsByRefusal.get(key)
        if (entry === undefined) {
          runsByRefusal.set(key, { gate: row.value.gate, rule: row.value.rule, runs: new Set([row.run_id]) })
        } else {
          entry.runs.add(row.run_id)
        }
      }
      return [...runsByRefusal.values()]
        .map((entry) => ({ gate: entry.gate, rule: entry.rule, runs: entry.runs.size }))
        .toSorted((left, right) => right.runs - left.runs || left.gate.localeCompare(right.gate) || (left.rule ?? "").localeCompare(right.rule ?? ""))
    })
  )

const displayRule = (rule: string | null): string => rule ?? "\u2014"

export const formatRefusalsTable = (counts: ReadonlyArray<RefusalCount>): string =>
  formatTable(["GATE", "RULE", "RUNS"], counts.map((count): ReadonlyArray<string> => [count.gate, displayRule(count.rule), count.runs.toString()]), "no gate refusals recorded")
