import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { RunSqlRowSchema, sqlite, type RunRecord, type SqliteFailure } from "./run-history"

export interface BranchStep {
  readonly name: string
  readonly status: string
  readonly attempt: number
  readonly piSessionFile: string | null
}

const BranchStepRowSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  attempt: Schema.Finite,
  pi_session_file: Schema.NullOr(Schema.String)
})

export const latestRunForBranch = (
  db: Database,
  project: string,
  branch: string
): Effect.Effect<RunRecord | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query(
      "SELECT id, project, branch, task_file, status, started, ended, pr_link, end_reason FROM runs WHERE project = ? AND branch = ? ORDER BY started DESC, id DESC LIMIT 1"
    ).get(project, branch)
  ).pipe(
    Effect.flatMap((row) =>
      row === null || row === undefined
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(RunSqlRowSchema)(row).pipe(
          Effect.map((decoded) => ({
            id: decoded.id,
            project: decoded.project,
            branch: decoded.branch,
            taskFile: decoded.task_file,
            status: decoded.status,
            started: decoded.started,
            ended: decoded.ended,
            prLink: decoded.pr_link,
            endReason: decoded.end_reason
          }))
        )
    )
  )

export const stepsForRun = (
  db: Database,
  runId: string
): Effect.Effect<ReadonlyArray<BranchStep>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query("SELECT name, status, attempt, pi_session_file FROM steps WHERE run_id = ? ORDER BY id ASC").all(runId)
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BranchStepRowSchema))),
    Effect.map((rows) => rows.map((row) => ({ name: row.name, status: row.status, attempt: row.attempt, piSessionFile: row.pi_session_file })))
  )

export interface StoredChecksRound {
  readonly round: number
  readonly file: string
  readonly started: string
  readonly ended: string
  readonly passed: boolean
  readonly checks: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>
}

export interface StoredFix {
  readonly attempt: number
  readonly status: string
  readonly started: string
  readonly ended: string
  readonly agentFile: string | null
  readonly sessionFile: string | null
  readonly evidenceIn: string
  readonly commits: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

const ChecksStepRowSchema = Schema.Struct({
  id: Schema.Finite,
  attempt: Schema.Finite,
  status: Schema.String,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String)
})

const EvidencePathRowSchema = Schema.Struct({ path: Schema.String })

const SignalRowSchema = Schema.Struct({ name: Schema.String, value: Schema.String })

const FixStepRowSchema = Schema.Struct({
  id: Schema.Finite,
  attempt: Schema.Finite,
  status: Schema.String,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  agent_file: Schema.NullOr(Schema.String),
  pi_session_file: Schema.NullOr(Schema.String)
})

const checksFileFor = (db: Database, stepId: number): Effect.Effect<string, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT path FROM evidence WHERE step_id = ? AND kind = ? ORDER BY id ASC LIMIT 1").all(stepId, "checks")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(EvidencePathRowSchema))),
    Effect.map((rows) => rows[0]?.path ?? "")
  )

const checksSignalsFor = (db: Database, stepId: number): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly passed: boolean }>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT name, value FROM signals WHERE step_id = ? ORDER BY name ASC").all(stepId)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SignalRowSchema))),
    Effect.map((rows) =>
      rows.filter((signal) => signal.name.startsWith("check ")).map((signal) => ({ name: signal.name.slice(6), passed: signal.value === "passed" }))
    )
  )

export const checksRoundsForRun = (db: Database, runId: string): Effect.Effect<ReadonlyArray<StoredChecksRound>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT id, attempt, status, started, ended FROM steps WHERE run_id = ? AND name = ? ORDER BY attempt ASC").all(runId, "checks")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ChecksStepRowSchema))),
    Effect.flatMap((steps) =>
      Effect.forEach(steps, (step) =>
        Effect.gen(function*() {
          const file = yield* checksFileFor(db, step.id)
          const checks = yield* checksSignalsFor(db, step.id)
          return { round: step.attempt, file, started: step.started, ended: step.ended ?? step.started, passed: step.status === "passed", checks }
        })
      )
    )
  )

const fixSignalsFor = (db: Database, stepId: number): Effect.Effect<ReadonlyMap<string, string>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT name, value FROM signals WHERE step_id = ?").all(stepId)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SignalRowSchema))),
    Effect.map((rows) => new Map(rows.map((signal) => [signal.name, signal.value] as const)))
  )

const countSignal = (signals: ReadonlyMap<string, string>, name: string): number =>
  Number.parseInt(signals.get(name) ?? "0", 10)

const tokenSignal = (signals: ReadonlyMap<string, string>, name: string): number | null =>
  signals.has(name) ? Number.parseInt(signals.get(name) ?? "0", 10) : null

export const fixesForRun = (db: Database, runId: string): Effect.Effect<ReadonlyArray<StoredFix>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT id, attempt, status, started, ended, agent_file, pi_session_file FROM steps WHERE run_id = ? AND name = ? ORDER BY attempt ASC").all(runId, "fix")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FixStepRowSchema))),
    Effect.flatMap((steps) =>
      Effect.forEach(steps, (step) =>
        Effect.gen(function*() {
          const evidenceIn = yield* checksFileFor(db, step.id)
          const signals = yield* fixSignalsFor(db, step.id)
          return {
            attempt: step.attempt,
            status: step.status,
            started: step.started,
            ended: step.ended ?? step.started,
            agentFile: step.agent_file,
            sessionFile: step.pi_session_file,
            evidenceIn,
            commits: countSignal(signals, "commit-count"),
            inputTokens: tokenSignal(signals, "input-tokens"),
            outputTokens: tokenSignal(signals, "output-tokens")
          }
        })
      )
    )
  )
