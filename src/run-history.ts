import { Database } from "bun:sqlite"
import { Data, Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { homedir } from "node:os"

export const RUN_HISTORY_SCHEMA_VERSION = 1
export const RUNS_JSON_SCHEMA = "orc.runs.v1" as const

const RunStatusSchema = Schema.Literals(["running", "succeeded", "failed"])
export type RunStatus = typeof RunStatusSchema.Type
const StepStatusSchema = Schema.Literals(["running", "passed", "failed", "skipped"])
export type StepStatus = typeof StepStatusSchema.Type
const EvidenceDirectionSchema = Schema.Literals(["in", "out"])
export type EvidenceDirection = typeof EvidenceDirectionSchema.Type
const ScoreValueSchema = Schema.Literals([1, 2, 3, 4, 5])
export type ScoreValue = typeof ScoreValueSchema.Type

export class UnsupportedSchemaVersion extends Data.TaggedError("UnsupportedSchemaVersion")<{
  readonly found: number
  readonly expected: number
}> {}

export class SqliteFailure extends Data.TaggedError("SqliteFailure")<{
  readonly cause: unknown
}> {}

const sqlite = <A>(use: () => A): Effect.Effect<A, SqliteFailure> =>
  Effect.try({ try: use, catch: (cause) => new SqliteFailure({ cause }) })

export interface RunInput {
  readonly id: string
  readonly project: string
  readonly branch: string
  readonly taskFile: string
  readonly status: RunStatus
  readonly started: string
  readonly ended?: string | null | undefined
  readonly prLink?: string | null | undefined
  readonly endReason?: string | null | undefined
}

export interface RunRecord {
  readonly id: string
  readonly project: string
  readonly branch: string
  readonly taskFile: string
  readonly status: RunStatus
  readonly started: string
  readonly ended: string | null
  readonly prLink: string | null
  readonly endReason: string | null
}

export interface StepInput {
  readonly runId: string
  readonly name: string
  readonly attempt: number
  readonly status: StepStatus
  readonly started: string
  readonly ended?: string | null | undefined
  readonly agentFile?: string | null | undefined
  readonly piSessionFile?: string | null | undefined
}

export interface StepRecord {
  readonly id: number
  readonly runId: string
  readonly name: string
  readonly attempt: number
  readonly status: StepStatus
  readonly started: string
  readonly ended: string | null
  readonly agentFile: string | null
  readonly piSessionFile: string | null
}

export interface EvidenceInput {
  readonly stepId: number
  readonly direction: EvidenceDirection
  readonly path: string
  readonly kind: string
}

export interface SignalInput {
  readonly stepId: number
  readonly name: string
  readonly value: string
}

export interface ScoreInput {
  readonly stepId: number
  readonly score: ScoreValue
  readonly note: string
  readonly scoredAt: string
}

export interface RunJsonEntry {
  readonly id: string
  readonly project: string
  readonly branch: string
  readonly status: RunStatus
  readonly prLink: string | null
}

export interface RunsJsonDocument {
  readonly schema: typeof RUNS_JSON_SCHEMA
  readonly runs: ReadonlyArray<RunJsonEntry>
}

export type HistoryError = PlatformError | Schema.SchemaError | UnsupportedSchemaVersion | SqliteFailure

export const orcHomeDir = (): string => `${homedir()}/.orc`

const schemaStatements: ReadonlyArray<string> = [
  "CREATE TABLE IF NOT EXISTS runs (" +
    "id TEXT PRIMARY KEY, " +
    "project TEXT NOT NULL, " +
    "branch TEXT NOT NULL, " +
    "task_file TEXT NOT NULL, " +
    "status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')), " +
    "started TEXT NOT NULL, " +
    "ended TEXT, " +
    "pr_link TEXT, " +
    "end_reason TEXT" +
    ")",
  "CREATE TABLE IF NOT EXISTS steps (" +
    "id INTEGER PRIMARY KEY, " +
    "run_id TEXT NOT NULL REFERENCES runs (id), " +
    "name TEXT NOT NULL, " +
    "attempt INTEGER NOT NULL DEFAULT 1, " +
    "status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'skipped')), " +
    "started TEXT NOT NULL, " +
    "ended TEXT, " +
    "agent_file TEXT, " +
    "pi_session_file TEXT" +
    ")",
  "CREATE TABLE IF NOT EXISTS evidence (" +
    "id INTEGER PRIMARY KEY, " +
    "step_id INTEGER NOT NULL REFERENCES steps (id), " +
    "direction TEXT NOT NULL CHECK (direction IN ('in', 'out')), " +
    "path TEXT NOT NULL, " +
    "kind TEXT NOT NULL" +
    ")",
  "CREATE TABLE IF NOT EXISTS signals (" +
    "id INTEGER PRIMARY KEY, " +
    "step_id INTEGER NOT NULL REFERENCES steps (id), " +
    "name TEXT NOT NULL, " +
    "value TEXT NOT NULL" +
    ")",
  "CREATE TABLE IF NOT EXISTS scores (" +
    "id INTEGER PRIMARY KEY, " +
    "step_id INTEGER NOT NULL REFERENCES steps (id), " +
    "score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5), " +
    "note TEXT NOT NULL DEFAULT '', " +
    "scored_at TEXT NOT NULL" +
    ")",
  "CREATE INDEX IF NOT EXISTS steps_by_run ON steps (run_id)",
  "CREATE INDEX IF NOT EXISTS evidence_by_step ON evidence (step_id)",
  "CREATE INDEX IF NOT EXISTS signals_by_step ON signals (step_id)",
  "CREATE INDEX IF NOT EXISTS scores_by_step ON scores (step_id)"
]

const SchemaVersionRow = Schema.Struct({ user_version: Schema.Finite })

const migrate = (db: Database): Effect.Effect<void, HistoryError> =>
  Effect.gen(function*() {
    const versionRow = yield* sqlite(() => db.query("PRAGMA user_version").get())
    const current = (yield* Schema.decodeUnknownEffect(SchemaVersionRow)(versionRow)).user_version
    if (current === RUN_HISTORY_SCHEMA_VERSION) {
      return
    }
    if (current !== 0) {
      return yield* new UnsupportedSchemaVersion({ found: current, expected: RUN_HISTORY_SCHEMA_VERSION })
    }
    yield* sqlite(() => {
      for (const statement of schemaStatements) {
        db.run(statement)
      }
      db.run(`PRAGMA user_version = ${RUN_HISTORY_SCHEMA_VERSION}`)
    })
  })

export const openDatabase = (
  homeDir: string
): Effect.Effect<Database, HistoryError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(homeDir, { recursive: true })
    const db = yield* sqlite(() => new Database(path.join(homeDir, "orc.sqlite"), { create: true }))
    return yield* migrate(db).pipe(
      Effect.as(db),
      Effect.onError(() => Effect.sync(() => db.close()))
    )
  })

export const recordRun = (db: Database, input: RunInput): Effect.Effect<void, SqliteFailure> =>
  sqlite(() => {
    db.query(
      "INSERT INTO runs (id, project, branch, task_file, status, started, ended, pr_link, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      input.id,
      input.project,
      input.branch,
      input.taskFile,
      input.status,
      input.started,
      input.ended ?? null,
      input.prLink ?? null,
      input.endReason ?? null
    )
  })

export const recordStep = (db: Database, input: StepInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() =>
    Number(
      db.query(
        "INSERT INTO steps (run_id, name, attempt, status, started, ended, agent_file, pi_session_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        input.runId,
        input.name,
        input.attempt,
        input.status,
        input.started,
        input.ended ?? null,
        input.agentFile ?? null,
        input.piSessionFile ?? null
      ).lastInsertRowid
    )
  )

export const recordEvidence = (db: Database, input: EvidenceInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() =>
    Number(
      db.query(
        "INSERT INTO evidence (step_id, direction, path, kind) VALUES (?, ?, ?, ?)"
      ).run(input.stepId, input.direction, input.path, input.kind).lastInsertRowid
    )
  )

export const recordSignal = (db: Database, input: SignalInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() =>
    Number(
      db.query(
        "INSERT INTO signals (step_id, name, value) VALUES (?, ?, ?)"
      ).run(input.stepId, input.name, input.value).lastInsertRowid
    )
  )

export const recordScore = (db: Database, input: ScoreInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() =>
    Number(
      db.query(
        "INSERT INTO scores (step_id, score, note, scored_at) VALUES (?, ?, ?, ?)"
      ).run(input.stepId, input.score, input.note, input.scoredAt).lastInsertRowid
    )
  )

const RunSqlRowSchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  task_file: Schema.String,
  status: RunStatusSchema,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  pr_link: Schema.NullOr(Schema.String),
  end_reason: Schema.NullOr(Schema.String)
})

export const listRuns = (
  db: Database,
  limit = 20
): Effect.Effect<ReadonlyArray<RunRecord>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query(
      "SELECT id, project, branch, task_file, status, started, ended, pr_link, end_reason FROM runs ORDER BY started DESC, id ASC LIMIT ?"
    ).all(limit)
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSqlRowSchema))),
    Effect.map((rows) =>
      rows.map((row) => ({
        id: row.id,
        project: row.project,
        branch: row.branch,
        taskFile: row.task_file,
        status: row.status,
        started: row.started,
        ended: row.ended,
        prLink: row.pr_link,
        endReason: row.end_reason
      }))
    )
  )

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
  return table.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ")).join("\n")
}
