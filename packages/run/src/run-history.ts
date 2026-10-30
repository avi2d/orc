import { Database } from "bun:sqlite"
import { Data, Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { homedir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { sandboxKinds, type SandboxKind } from "./args"

export const RUN_HISTORY_SCHEMA_VERSION = 2
export const RUNS_JSON_SCHEMA = "orc.runs.v1" as const
export const SHOW_JSON_SCHEMA = "orc.show.v1" as const

export const RunStatusSchema = Schema.Literals(["running", "succeeded", "failed"])
type RunStatus = typeof RunStatusSchema.Type
export const StepStatusSchema = Schema.Literals(["running", "passed", "failed", "skipped"])
type StepStatus = typeof StepStatusSchema.Type
export const EvidenceDirectionSchema = Schema.Literals(["in", "out"])
type EvidenceDirection = typeof EvidenceDirectionSchema.Type
export const ScoreValueSchema = Schema.Literals([1, 2, 3, 4, 5])
type ScoreValue = typeof ScoreValueSchema.Type

class UnsupportedSchemaVersion extends Data.TaggedError("UnsupportedSchemaVersion")<{
  readonly found: number
  readonly expected: number
}> {}

export class SqliteFailure extends Data.TaggedError("SqliteFailure")<{
  readonly cause: unknown
}> {}

export const sqlite = <A>(use: () => A): Effect.Effect<A, SqliteFailure> =>
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
  readonly sandbox?: SandboxKind | null | undefined
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
  readonly sandbox: SandboxKind | null
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

const RunJsonEntrySchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  status: RunStatusSchema,
  prLink: Schema.NullOr(Schema.String)
})

const RunsJsonSchema = Schema.Struct({
  schema: Schema.Literal(RUNS_JSON_SCHEMA),
  runs: Schema.Array(RunJsonEntrySchema)
})

export type RunsJsonDocument = typeof RunsJsonSchema.Type

export type HistoryError = PlatformError | Schema.SchemaError | UnsupportedSchemaVersion | SqliteFailure

export const formatHistoryError = (error: unknown): string => {
  if (error instanceof UnsupportedSchemaVersion) {
    return "unsupported schema version " + error.found + ", expected " + error.expected
  }
  if (error instanceof SqliteFailure) {
    return error.cause instanceof Error ? error.cause.message : String(error.cause)
  }
  return String(error)
}

// Effect scope refuses node:path here, so a file URL resolves the override.
export const orcHomeDir = (override?: string): string =>
  override === undefined || override === "" ? `${homedir()}/.orc` : fileURLToPath(new URL(override, pathToFileURL(process.cwd() + "/")))

const sandboxColumn = "sandbox TEXT CHECK (sandbox IN (" + sandboxKinds.map((kind) => "'" + kind + "'").join(", ") + "))"

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
    "end_reason TEXT, " +
    sandboxColumn + ")",
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

const busyTimeoutMillis = 5000

const upgrades: ReadonlyMap<number, ReadonlyArray<string>> = new Map([[0, schemaStatements], [1, ["ALTER TABLE runs ADD COLUMN " + sandboxColumn]]])

const readSchemaVersion = (db: Database): Effect.Effect<number, HistoryError> =>
  sqlite(() => db.query("PRAGMA user_version").get()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SchemaVersionRow)), Effect.map((row) => row.user_version))

const migrate = (db: Database): Effect.Effect<void, HistoryError> =>
  Effect.gen(function*() {
    const current = yield* readSchemaVersion(db)
    if (current === RUN_HISTORY_SCHEMA_VERSION) {
      return
    }
    if (!upgrades.has(current)) {
      return yield* new UnsupportedSchemaVersion({ found: current, expected: RUN_HISTORY_SCHEMA_VERSION })
    }
    // Another orc can upgrade the same file between the read above and the write, and ADD COLUMN fails when run twice.
    yield* sqlite(() => db.run("BEGIN IMMEDIATE"))
    yield* readSchemaVersion(db).pipe(
      Effect.flatMap((locked) =>
        sqlite(() => {
          const statements = upgrades.get(locked)
          if (statements !== undefined) {
            statements.forEach((statement) => db.run(statement))
            db.run(`PRAGMA user_version = ${RUN_HISTORY_SCHEMA_VERSION}`)
          }
          db.run("COMMIT")
        })
      ),
      Effect.onError(() => sqlite(() => db.run("ROLLBACK")).pipe(Effect.result))
    )
  })

export const openDatabase = (
  homeDir: string
): Effect.Effect<Database, HistoryError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(homeDir, { recursive: true })
    const db = yield* sqlite(() => new Database(path.join(homeDir, "orc.sqlite"), { create: true }))
    return yield* sqlite(() => db.run(`PRAGMA busy_timeout = ${busyTimeoutMillis}`)).pipe(
      Effect.andThen(migrate(db)),
      Effect.as(db),
      Effect.onError(() => Effect.sync(() => db.close()))
    )
  })

export const insertRun = (db: Database, input: RunInput): void => {
  db.query(
    "INSERT INTO runs (id, project, branch, task_file, status, started, ended, pr_link, end_reason, sandbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
      input.id,
      input.project,
      input.branch,
      input.taskFile,
      input.status,
      input.started,
      input.ended ?? null,
      input.prLink ?? null,
      input.endReason ?? null,
      input.sandbox ?? null
    )
}

export const recordRun = (db: Database, input: RunInput): Effect.Effect<void, SqliteFailure> =>
  sqlite(() => insertRun(db, input))

export const insertStep = (db: Database, input: StepInput): number =>
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

export const recordStep = (db: Database, input: StepInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() => insertStep(db, input))

export const insertEvidence = (db: Database, input: EvidenceInput): number =>
  Number(
      db.query(
        "INSERT INTO evidence (step_id, direction, path, kind) VALUES (?, ?, ?, ?)"
      ).run(input.stepId, input.direction, input.path, input.kind).lastInsertRowid
  )

export const recordEvidence = (db: Database, input: EvidenceInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() => insertEvidence(db, input))

export const insertSignal = (db: Database, input: SignalInput): number =>
  Number(
      db.query(
        "INSERT INTO signals (step_id, name, value) VALUES (?, ?, ?)"
      ).run(input.stepId, input.name, input.value).lastInsertRowid
  )

export const recordSignal = (db: Database, input: SignalInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() => insertSignal(db, input))

export const recordScore = (db: Database, input: ScoreInput): Effect.Effect<number, SqliteFailure> =>
  sqlite(() =>
    Number(
      db.query(
        "INSERT INTO scores (step_id, score, note, scored_at) VALUES (?, ?, ?, ?)"
      ).run(input.stepId, input.score, input.note, input.scoredAt).lastInsertRowid
    )
  )

export const RunSqlRowSchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  task_file: Schema.String,
  status: RunStatusSchema,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  pr_link: Schema.NullOr(Schema.String),
  end_reason: Schema.NullOr(Schema.String),
  sandbox: Schema.NullOr(Schema.Literals(sandboxKinds))
})

const runRecordOf = (row: typeof RunSqlRowSchema.Type): RunRecord => ({
  id: row.id,
  project: row.project,
  branch: row.branch,
  taskFile: row.task_file,
  status: row.status,
  started: row.started,
  ended: row.ended,
  prLink: row.pr_link,
  endReason: row.end_reason,
  sandbox: row.sandbox
})

const runColumns = "SELECT id, project, branch, task_file, status, started, ended, pr_link, end_reason, sandbox FROM runs"

export const listRuns = (
  db: Database,
  limit = 20
): Effect.Effect<ReadonlyArray<RunRecord>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query(runColumns + " ORDER BY started DESC, id ASC LIMIT ?").all(limit)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSqlRowSchema))),
    Effect.map((rows) => rows.map(runRecordOf))
  )

export const updateRun = (db: Database, id: string, patch: { readonly status: RunStatus; readonly ended: string | null; readonly prLink: string | null; readonly endReason: string | null }): Effect.Effect<void, SqliteFailure> =>
  sqlite(() => {
    db.query("UPDATE runs SET status = ?, ended = ?, pr_link = ?, end_reason = ? WHERE id = ?").run(patch.status, patch.ended, patch.prLink, patch.endReason, id)
  })

const StepIdRowSchema = Schema.Struct({ id: Schema.Finite })

export const stepIdFor = (db: Database, runId: string, name: string, attempt: number): Effect.Effect<number | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT id FROM steps WHERE run_id = ? AND name = ? AND attempt = ? ORDER BY id ASC LIMIT 1").get(runId, name, attempt)).pipe(
    Effect.flatMap((row) =>
      row === null || row === undefined
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(StepIdRowSchema)(row).pipe(Effect.map((decoded) => decoded.id))
    )
  )

const StepUpdateResultSchema = Schema.Struct({ changes: Schema.Union([Schema.Finite, Schema.BigInt]) })

export const updateStep = (db: Database, runId: string, name: string, attempt: number, patch: { readonly status: StepStatus; readonly ended: string | null; readonly piSessionFile?: string | null | undefined }): Effect.Effect<boolean, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query("UPDATE steps SET status = ?, ended = ?, pi_session_file = COALESCE(?, pi_session_file) WHERE run_id = ? AND name = ? AND attempt = ?").run(patch.status, patch.ended, patch.piSessionFile ?? null, runId, name, attempt)
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StepUpdateResultSchema)),
    Effect.map((decoded) => Number(decoded.changes) > 0)
  )

export const sessionIdFromFile = (file: string | null): string | null => {
  if (file === null) {
    return null
  }
  const base = file.slice(file.lastIndexOf("/") + 1)
  const bare = base.endsWith(".jsonl") ? base.slice(0, -6) : base
  const cut = bare.lastIndexOf("_")
  const candidate = cut === -1 ? bare : bare.slice(cut + 1)
  return candidate === "" ? null : candidate
}

export const toFileUrl = (path: string): string => pathToFileURL(path).href

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

export const encodeRunsJson = (runs: ReadonlyArray<RunRecord>): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(RunsJsonSchema)(runsJson(runs)).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeRunsJson = (value: unknown): Effect.Effect<RunsJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RunsJsonSchema)(value)

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
  return table.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd())
    .join("\n")
}
