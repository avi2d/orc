import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Schema } from "effect"
import { type RunRecord, sqlite, type SqliteFailure, StepStatusSchema } from "../../entities/run-history/index"
import { Asking, askingFileName } from "../../entities/review-gate/index"
import { readJsonFileIfPresent } from "../../shared/config/index"

export const LatestStepSchema = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  attempt: Schema.Finite,
  status: StepStatusSchema
})
export type LatestStep = typeof LatestStepSchema.Type

export interface ListedRun {
  readonly run: RunRecord
  readonly title: string | null
  readonly step: LatestStep | null
  readonly questions: number
}

export const runDirOf = (taskFile: string): string => {
  const separator = taskFile.lastIndexOf("/")
  return separator < 0 ? "." : taskFile.slice(0, separator)
}

export const titleOf = (taskText: string): string | null => {
  const line = taskText.split("\n").map((entry) => entry.replace(/^#+\s*/, "").trim()).find((entry) => entry !== "")
  return line ?? null
}

const readTitle = (taskFile: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(taskFile)),
    Effect.map(titleOf),
    Effect.orElseSucceed(() => null)
  )

// Only a running run's asking.json is a question still open: the wait removes the file as it ends.
const readQuestions = (run: RunRecord): Effect.Effect<number, never, FileSystem.FileSystem> =>
  run.status !== "running"
    ? Effect.succeed(0)
    : readJsonFileIfPresent(runDirOf(run.taskFile) + "/" + askingFileName, Asking).pipe(
      Effect.map((asking) => asking?.questions.length ?? 0),
      Effect.orElseSucceed(() => 0)
    )

const readLatestStep = (db: Database, runId: string): Effect.Effect<LatestStep | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() =>
    db.query("SELECT id, name, attempt, status FROM steps WHERE run_id = ? ORDER BY status = 'running' DESC, started DESC, id DESC LIMIT 1").get(runId)
  ).pipe(
    Effect.flatMap((row) => row === null || row === undefined ? Effect.succeed(null) : Schema.decodeUnknownEffect(LatestStepSchema)(row))
  )

export const readListedRuns = (
  db: Database,
  runs: ReadonlyArray<RunRecord>
): Effect.Effect<ReadonlyArray<ListedRun>, Schema.SchemaError | SqliteFailure, FileSystem.FileSystem> =>
  Effect.forEach(runs, (run) =>
    Effect.all({ title: readTitle(run.taskFile), step: readLatestStep(db, run.id), questions: readQuestions(run) }).pipe(
      Effect.map((facts) => ({ run, ...facts }))
    ))
