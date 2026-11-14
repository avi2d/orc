import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { pathToFileURL } from "node:url"
import { sandboxKinds } from "../../shared/sandbox/index"
import type { OrcRunError } from "../../shared/lib/index"
import { RunStatusSchema, StepStatusSchema, historyFailure, sqlite, type RunRecord, type SqliteFailure } from "./run-history"

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
  sandbox: Schema.NullOr(Schema.Literals(sandboxKinds)),
  kind: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  task: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  worktree: Schema.NullOr(Schema.String)
})

export const runRecordOf = (row: typeof RunSqlRowSchema.Type): RunRecord => ({
  id: row.id,
  project: row.project,
  branch: row.branch,
  taskFile: row.task_file,
  status: row.status,
  started: row.started,
  ended: row.ended,
  prLink: row.pr_link,
  endReason: row.end_reason,
  sandbox: row.sandbox,
  kind: row.kind,
  delivery: row.delivery,
  task: row.task,
  machine: row.machine,
  worktree: row.worktree
})

export const decodedRunRow = (row: unknown): Effect.Effect<RunRecord | null, Schema.SchemaError> =>
  row === null || row === undefined
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(RunSqlRowSchema)(row).pipe(Effect.map(runRecordOf))

export const stoppedEndReason = "the run was stopped"

export const runColumns = "SELECT id, project, branch, task_file, status, started, ended, pr_link, end_reason, sandbox, kind, delivery, task, machine, worktree FROM runs"

export const runById = (db: Database, id: string): Effect.Effect<RunRecord | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query(runColumns + " WHERE id = ?").get(id)).pipe(Effect.flatMap(decodedRunRow))

export const listRuns = (db: Database, limit = 20): Effect.Effect<ReadonlyArray<RunRecord>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query(runColumns + " ORDER BY started DESC, id ASC LIMIT ?").all(limit)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSqlRowSchema))),
    Effect.map((rows) => rows.map(runRecordOf))
  )

export const listAllRuns = (db: Database): Effect.Effect<ReadonlyArray<RunRecord>, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query(runColumns + " ORDER BY started DESC, id ASC").all()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSqlRowSchema))),
    Effect.map((rows) => rows.map(runRecordOf))
  )

export const updateRun = (db: Database, id: string, patch: { readonly status: typeof RunStatusSchema.Type; readonly ended: string | null; readonly prLink: string | null; readonly endReason: string | null }): Effect.Effect<void, SqliteFailure> =>
  sqlite(() => {
    db.query("UPDATE runs SET status = ?, ended = ?, pr_link = ?, end_reason = ? WHERE id = ?").run(patch.status, patch.ended, patch.prLink, patch.endReason, id)
  })

export const StepSqlRowSchema = Schema.Struct({
  id: Schema.Finite,
  run_id: Schema.String,
  name: Schema.String,
  attempt: Schema.Finite,
  status: StepStatusSchema,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  agent_file: Schema.NullOr(Schema.String),
  pi_session_file: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  thinking: Schema.NullOr(Schema.String)
})

const StepIdRowSchema = Schema.Struct({ id: Schema.Finite })

export const stepIdFor = (db: Database, runId: string, name: string, attempt: number): Effect.Effect<number | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT id FROM steps WHERE run_id = ? AND name = ? AND attempt = ? ORDER BY id DESC LIMIT 1").get(runId, name, attempt)).pipe(
    Effect.flatMap((row) =>
      row === null || row === undefined
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(StepIdRowSchema)(row).pipe(Effect.map((decoded) => decoded.id))
    )
  )

const StepUpdateResultSchema = Schema.Struct({ changes: Schema.Union([Schema.Finite, Schema.BigInt]) })

export const updateStep = (db: Database, runId: string, name: string, attempt: number, patch: { readonly status: typeof StepStatusSchema.Type; readonly ended: string | null; readonly piSessionFile?: string | null | undefined; readonly agentFile?: string | null | undefined; readonly model?: string | null | undefined; readonly thinking?: string | null | undefined }): Effect.Effect<boolean, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query("UPDATE steps SET status = ?, ended = ?, pi_session_file = COALESCE(?, pi_session_file), agent_file = COALESCE(?, agent_file), model = COALESCE(?, model), thinking = COALESCE(?, thinking) WHERE id = (SELECT id FROM steps WHERE run_id = ? AND name = ? AND attempt = ? ORDER BY id DESC LIMIT 1)").run(patch.status, patch.ended, patch.piSessionFile ?? null, patch.agentFile ?? null, patch.model ?? null, patch.thinking ?? null, runId, name, attempt)
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

export const markRunStopped = (db: Database, runId: string, ended: string, endReason: string): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const prior = yield* runById(db, runId).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    yield* updateRun(db, runId, { status: "stopped", ended, prLink: prior?.prLink ?? null, endReason }).pipe(
      Effect.mapError((cause) => historyFailure("record the run in", cause))
    )
  })

