import type { Database } from "bun:sqlite"
import { Data, Effect, FileSystem, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { sqlite, type SqliteFailure } from "../../entities/run-history/index"
import { runDirOf } from "./run-facts"
import { UnknownRun, UnknownStep } from "./run-scores"

const RunRowSchema = Schema.Struct({ task_file: Schema.String })
const StepRowSchema = Schema.Struct({ name: Schema.String, attempt: Schema.Finite })
const OutRowsSchema = Schema.Array(Schema.Struct({ kind: Schema.String, path: Schema.String }))

export type LoggedStep = typeof StepRowSchema.Type & { readonly out: typeof OutRowsSchema.Type }

// An agent step appends to its log as Pi writes, while its session file holds the turns as JSON.
export const stepLogFile = (runDir: string, step: LoggedStep): string | null => {
  if (step.name === "implement") {
    return runDir + "/agent.log"
  }
  if (step.name === "fix") {
    return runDir + "/fix-" + step.attempt.toString() + ".log"
  }
  return step.out.filter((item) => item.kind !== "session").at(-1)?.path ?? null
}

export class NoStepLog extends Data.TaggedError("NoStepLog")<{
  readonly runId: string
  readonly stepId: number
}> {}

export const readStepLog = (
  db: Database,
  runId: string,
  stepId: number
): Effect.Effect<string, UnknownRun | UnknownStep | NoStepLog | PlatformError | Schema.SchemaError | SqliteFailure, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const runRow = yield* sqlite(() => db.query("SELECT task_file FROM runs WHERE id = ?").get(runId))
    if (runRow === null || runRow === undefined) {
      return yield* new UnknownRun({ runId })
    }
    const run = yield* Schema.decodeUnknownEffect(RunRowSchema)(runRow)
    const stepRow = yield* sqlite(() => db.query("SELECT name, attempt FROM steps WHERE run_id = ? AND id = ?").get(runId, stepId))
    if (stepRow === null || stepRow === undefined) {
      return yield* new UnknownStep({ runId, step: stepId.toString() })
    }
    const step = yield* Schema.decodeUnknownEffect(StepRowSchema)(stepRow)
    const out = yield* sqlite(() => db.query("SELECT kind, path FROM evidence WHERE step_id = ? AND direction = 'out' ORDER BY id ASC").all(stepId)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OutRowsSchema))
    )
    const file = stepLogFile(runDirOf(run.task_file), { ...step, out })
    if (file === null) {
      return yield* new NoStepLog({ runId, stepId })
    }
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")))
  })
