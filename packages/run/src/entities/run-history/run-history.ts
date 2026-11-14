import { Database } from "bun:sqlite"
import { Data, Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { homedir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { sandboxKinds, type SandboxKind } from "../../shared/sandbox/index"
import { OrcRunError } from "../../shared/lib/index"

export const RUN_HISTORY_SCHEMA_VERSION = 5
export const RUNS_JSON_SCHEMA = "orc.runs.v1" as const
export const SHOW_JSON_SCHEMA = "orc.show.v1" as const

export const RunStatusSchema = Schema.Literals(["running", "succeeded", "failed", "stopped"])
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
  readonly kind?: string | null | undefined
  readonly delivery?: string | null | undefined
  readonly task?: string | null | undefined
  readonly machine?: string | null | undefined
  readonly worktree?: string | null | undefined
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
  readonly kind: string | null
  readonly delivery: string | null
  readonly task: string | null
  readonly machine: string | null
  readonly worktree: string | null
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
  readonly model?: string | null | undefined
  readonly thinking?: string | null | undefined
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

const runFactColumns: ReadonlyArray<string> = ["task TEXT", "machine TEXT", "worktree TEXT"]
const stepAgentColumns: ReadonlyArray<string> = ["model TEXT", "thinking TEXT"]
const addRunFacts = runFactColumns.map((column) => "ALTER TABLE runs ADD COLUMN " + column)
const addStepAgents = stepAgentColumns.map((column) => "ALTER TABLE steps ADD COLUMN " + column)

const sandboxColumn = "sandbox TEXT CHECK (sandbox IN (" + sandboxKinds.map((kind) => "'" + kind + "'").join(", ") + "))"

const runsColumns =
  "id TEXT PRIMARY KEY, " +
  "project TEXT NOT NULL, " +
  "branch TEXT NOT NULL, " +
  "task_file TEXT NOT NULL, " +
  "status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'stopped')), " +
  "started TEXT NOT NULL, " +
  "ended TEXT, " +
  "pr_link TEXT, " +
  "end_reason TEXT, " +
  sandboxColumn + ", " +
  "kind TEXT, " +
  "delivery TEXT, " +
  runFactColumns.join(", ")

const rebuildRunsForStopped: ReadonlyArray<string> = [
  "CREATE TABLE runs_new (" + runsColumns + ")",
  "INSERT INTO runs_new (id, project, branch, task_file, status, started, ended, pr_link, end_reason, sandbox) " +
    "SELECT id, project, branch, task_file, status, started, ended, pr_link, end_reason, sandbox FROM runs",
  "DROP TABLE runs",
  "ALTER TABLE runs_new RENAME TO runs"
]

const schemaStatements: ReadonlyArray<string> = [
  "CREATE TABLE IF NOT EXISTS runs (" + runsColumns + ")",
  "CREATE TABLE IF NOT EXISTS steps (" +
    "id INTEGER PRIMARY KEY, " +
    "run_id TEXT NOT NULL REFERENCES runs (id), " +
    "name TEXT NOT NULL, " +
    "attempt INTEGER NOT NULL DEFAULT 1, " +
    "status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'skipped')), " +
    "started TEXT NOT NULL, " +
    "ended TEXT, " +
    "agent_file TEXT, " +
    "pi_session_file TEXT, " +
    stepAgentColumns.join(", ") +
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

const upgrades: ReadonlyMap<number, ReadonlyArray<string>> = new Map([
  [0, schemaStatements],
  [1, ["ALTER TABLE runs ADD COLUMN " + sandboxColumn, ...rebuildRunsForStopped, ...addStepAgents]],
  [2, [...rebuildRunsForStopped, ...addStepAgents]],
  [3, ["ALTER TABLE runs ADD COLUMN kind TEXT", "ALTER TABLE runs ADD COLUMN delivery TEXT", ...addRunFacts, ...addStepAgents]],
  [4, [...addRunFacts, ...addStepAgents]]
])

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

export const openDatabase = (homeDir: string): Effect.Effect<Database, HistoryError, FileSystem.FileSystem | Path.Path> =>
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
    "INSERT INTO runs (id, project, branch, task_file, status, started, ended, pr_link, end_reason, sandbox, kind, delivery, task, machine, worktree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      input.sandbox ?? null,
      input.kind ?? null,
      input.delivery ?? null,
      input.task ?? null,
      input.machine ?? null,
      input.worktree ?? null
    )
}

export const recordRun = (db: Database, input: RunInput): Effect.Effect<void, SqliteFailure> =>
  sqlite(() => insertRun(db, input))

export const insertStep = (db: Database, input: StepInput): number =>
  Number(
      db.query(
        "INSERT INTO steps (run_id, name, attempt, status, started, ended, agent_file, pi_session_file, model, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        input.runId,
        input.name,
        input.attempt,
        input.status,
        input.started,
        input.ended ?? null,
        input.agentFile ?? null,
        input.piSessionFile ?? null,
        input.model ?? null,
        input.thinking ?? null
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

export const historyFailure = (action: string, cause: unknown): OrcRunError => new OrcRunError({ message: "orc: cannot " + action + " the run history: " + formatHistoryError(cause) })
