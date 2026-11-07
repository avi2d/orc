import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { sqlite, type SqliteFailure } from "./run-history"

export const GateRefusalSchema = Schema.Struct({ gate: Schema.String, rule: Schema.String })

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

const genericHeader = (line: string): string | null => {
  const gate = /^([A-Za-z_][\w.-]*): \d+ [^\n]*\((?:s|ies)\)/.exec(line)?.[1]
  return gate === undefined ? null : shortGate(gate)
}

const secretsHeader = (line: string): string | null =>
  /^secrets: the range adds \d+ secret\(s\);/.test(line) ? "secrets" : null

type GraphwalkSection = "imports" | "unused" | "exports"

const graphwalkHeader = (line: string): GraphwalkSection | null => {
  if (/^imports: \d+ violation\(s\) in/.test(line)) {
    return "imports"
  }
  if (/^unused: \d+ unreferenced file\(s\):/.test(line)) {
    return "unused"
  }
  if (/^exports: \d+ .*:$/.test(line)) {
    return "exports"
  }
  return null
}

const locatorStripped = (line: string): string => {
  const stripped = line.replace(/^\S+ line \d+:\s+|^[^:]+?:\d+(?::\d+)?:?\s+|^\S+:\s+|^(?=\S*[/.])\S+\s+/, "")
  return stripped === "" ? line : stripped
}

const singleLinePrefixes: ReadonlyArray<readonly [string, string]> = [
  ["effect-scope", "the @effect/language-service entry in tsconfig.json differs"],
  ["lint-coverage", "oxlint skips "],
  ["lint-coverage", "oxlint could not walk"],
  ["lint-coverage", "tsc could not list"],
  ["lint-coverage", "the program tsconfig.json builds drops"],
  ["commit-identity", "package.json declares no author"],
]

const singleLineRule = (gate: string, rest: string): string =>
  gate === "lint-coverage" ? rest.replace(/^oxlint skips \d+\/\d+ /, "oxlint skips ") : rest

const repetitionRule = (line: string): string | null => {
  const rise = /^(\d+) repeated line\(s\)(, up from (\d+))?$/.exec(line)
  if (rise === null) {
    return null
  }
  return rise[2] === undefined ? "repeated line(s)" : "repeated line(s), up from"
}

const testLayoutRule = (line: string): string =>
  line.replace(/; move it to \S+$/, "")

const commitRule = (line: string): string | null => {
  const kind = /^(author|committer)\s/.exec(line)?.[1]
  if (kind !== undefined) {
    return kind
  }
  const trailer = /^trailer\s+(.*)$/.exec(line)?.[1]?.trim()
  if (trailer !== undefined) {
    const key = /^([^:]+:)/.exec(trailer)?.[1]
    return key === undefined ? "trailer" : "trailer " + key
  }
  return null
}

const secretsRule = (line: string): string | null => {
  const rule = /^.+?\s+(\S+) in [0-9a-fA-F]+:\s*(.+)$/.exec(line)
  if (rule?.[1] === undefined || rule[2] === undefined) {
    return null
  }
  return rule[1] + ": " + rule[2]
}

const importsRule = (line: string): string | null => {
  const rule = /^(\S+) (\S+): /.exec(line)
  return rule?.[1] === undefined || rule[2] === undefined ? null : rule[1] + " " + rule[2]
}

export const refusalsIn = (output: string): ReadonlyArray<GateRefusal> => {
  const named = new Set(summaryGates(output))
  const allowed = (gate: string): boolean => named.size === 0 || named.has(gate)
  const seen = new Set<string>()
  const refusals: Array<GateRefusal> = []
  const keep = (gate: string, rule: string): void => {
    const key = gate + "\0" + rule
    if (rule === "" || seen.has(key)) {
      return
    }
    seen.add(key)
    refusals.push({ gate, rule })
  }
  let gate: string | null = null
  let section: GraphwalkSection | "secrets" | "commit" | "violation" | null = null
  for (const raw of output.split("\n")) {
    const secrets = secretsHeader(raw)
    if (secrets !== null) {
      gate = allowed(secrets) ? secrets : null
      section = gate === null ? null : "secrets"
      continue
    }
    const graphwalk = graphwalkHeader(raw)
    if (graphwalk !== null) {
      gate = allowed("graphwalk") ? "graphwalk" : null
      section = gate === null ? null : graphwalk
      continue
    }
    const header = genericHeader(raw)
    if (header !== null) {
      gate = allowed(header) ? header : null
      section = gate === null ? null : gate === "commit-identity" ? "commit" : "violation"
      continue
    }
    if (/^ /.test(raw)) {
      if (gate === null || section === null) {
        continue
      }
      if (section === "commit") {
        if (/^ {4}\S/.test(raw)) {
          const rule = commitRule(raw.trim())
          if (rule !== null) {
            keep(gate, rule)
          }
        }
        continue
      }
      if (/^ {4}\S/.test(raw)) {
        continue
      }
      if (!/^ {2}\S/.test(raw)) {
        continue
      }
      if (section === "secrets") {
        const rule = secretsRule(raw.trim())
        if (rule !== null) {
          keep(gate, rule)
        }
        continue
      }
      if (section === "imports") {
        const rule = importsRule(raw.trim())
        if (rule !== null) {
          keep(gate, rule)
        }
        continue
      }
      if (section === "unused") {
        if (!raw.trim().includes(":")) {
          keep(gate, "unreferenced file")
        }
        continue
      }
      if (section === "exports") {
        const rule = locatorStripped(raw.trim())
        if (rule.includes("(") && rule.includes(")")) {
          keep(gate, rule)
        }
        continue
      }
      if (gate === "repetition") {
        const rule = repetitionRule(locatorStripped(raw.trim()))
        if (rule !== null) {
          keep(gate, rule)
        }
        continue
      }
      if (gate === "test-layout") {
        keep(gate, testLayoutRule(locatorStripped(raw.trim())))
        continue
      }
      keep(
        gate,
        locatorStripped(raw.trim()).replace(/^.*,\s+over the /, "over the ").replace(
          /\. Its largest section is [^.]*\./,
          "."
        )
      )
      continue
    }
    gate = null
    section = null
    const single = /^([A-Za-z][A-Za-z0-9_-]*): (.+)$/.exec(raw)
    const name = single?.[1]
    const rest = single?.[2]?.trim()
    if (name !== undefined && rest !== undefined && rest !== "") {
      for (const [prefixGate, prefix] of singleLinePrefixes) {
        if (name === prefixGate && rest.startsWith(prefix) && allowed(prefixGate)) {
          keep(prefixGate, singleLineRule(prefixGate, rest))
          break
        }
      }
    }
  }
  return refusals
}

export const distinctRefusals = (refusals: ReadonlyArray<GateRefusal>): ReadonlyArray<GateRefusal> =>
  refusals.filter((refusal, index, all) =>
    all.findIndex((other) => other.gate === refusal.gate && other.rule === refusal.rule) === index
  )

export const refusalValue = (refusal: GateRefusal): string =>
  JSON.stringify({ gate: refusal.gate, rule: refusal.rule })

export const refusalSignalName = "refusal"

const RefusalCountSchema = Schema.Struct({
  gate: Schema.String,
  rule: Schema.String,
  runs: Schema.Finite
})

export type RefusalCount = typeof RefusalCountSchema.Type

export const REFUSALS_JSON_SCHEMA = "orc.refusals.v1" as const

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
      const runsByRefusal = new Map<string, { readonly gate: string; readonly rule: string; readonly runs: Set<string> }>()
      for (const row of rows) {
        const key = row.value.gate + "\0" + row.value.rule
        const entry = runsByRefusal.get(key)
        if (entry === undefined) {
          runsByRefusal.set(key, { gate: row.value.gate, rule: row.value.rule, runs: new Set([row.run_id]) })
        } else {
          entry.runs.add(row.run_id)
        }
      }
      return [...runsByRefusal.values()]
        .map((entry) => ({ gate: entry.gate, rule: entry.rule, runs: entry.runs.size }))
        .toSorted((left, right) => right.runs - left.runs || left.gate.localeCompare(right.gate) || left.rule.localeCompare(right.rule))
    })
  )

const ruleColumnWidth = 96

const displayRule = (rule: string): string =>
  rule.length <= ruleColumnWidth ? rule : rule.slice(0, ruleColumnWidth - 1) + "\u2026"

export const formatRefusalsTable = (counts: ReadonlyArray<RefusalCount>): string => {
  if (counts.length === 0) {
    return "no gate refusals recorded"
  }
  const header: ReadonlyArray<string> = ["GATE", "RULE", "RUNS"]
  const body = counts.map((count): ReadonlyArray<string> => [count.gate, displayRule(count.rule), count.runs.toString()])
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
