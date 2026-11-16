import type { Database } from "bun:sqlite"
import { Data, Effect, FileSystem, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { sqlite, type SqliteFailure } from "../../entities/run-history/index"
import { runDirOf } from "./run-facts"
import { StepStatusSchema } from "../../entities/run-history/index"
import { UnknownRun, UnknownStep } from "./run-scores"

const RunRowSchema = Schema.Struct({ task_file: Schema.String })
const StepRowSchema = Schema.Struct({ name: Schema.String, attempt: Schema.Finite, status: StepStatusSchema })
const OutRowsSchema = Schema.Array(Schema.Struct({ kind: Schema.String, path: Schema.String }))

export type LoggedStep = typeof StepRowSchema.Type & { readonly out: typeof OutRowsSchema.Type }

const runsDirOf = (runDir: string): string => runDir.slice(0, runDir.lastIndexOf("/") + 1)

const originKinds: ReadonlySet<string> = new Set(["log", "checks", "session"])

// A resume copies each carried step with the out evidence the earlier run wrote, so only that evidence names the run the step ran in.
// A retried carried step runs again in this run while it still holds the earlier evidence, so a running step is never carried.
export const carriedFrom = (runDir: string, step: Pick<LoggedStep, "status" | "out">): string | null => {
  if (step.status === "running") {
    return null
  }
  const runsDir = runsDirOf(runDir)
  const path = step.out.filter((item) => originKinds.has(item.kind)).at(-1)?.path
  if (path === undefined || runsDir === "" || !path.startsWith(runsDir)) {
    return null
  }
  const rest = path.slice(runsDir.length)
  const id = rest.slice(0, Math.max(rest.indexOf("/"), 0))
  return id === "" || runsDir + id === runDir ? null : id
}

// An agent step appends to its log as Pi writes, while its session file holds the turns as JSON.
export const stepLogFile = (runDir: string, step: LoggedStep, from: string | null = carriedFrom(runDir, step)): string | null => {
  const dir = from === null ? runDir : runsDirOf(runDir) + from
  if (step.name === "implement") {
    return step.out.filter((item) => item.kind === "log").at(-1)?.path ?? dir + "/agent.log"
  }
  if (step.name === "fix") {
    return step.out.filter((item) => item.kind === "log").at(-1)?.path ?? dir + "/fix-" + step.attempt.toString() + ".log"
  }
  if (step.name === "checks") {
    return step.out.filter((item) => item.kind === "checks").at(-1)?.path ?? dir + "/session/checks-" + step.attempt.toString() + ".txt"
  }
  return step.out.filter((item) => item.kind !== "session").at(-1)?.path ?? null
}

const SiblingRowsSchema = Schema.Array(Schema.Struct({ id: Schema.Finite, status: StepStatusSchema }))

const outRows = (db: Database, stepId: number): Effect.Effect<typeof OutRowsSchema.Type, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT kind, path FROM evidence WHERE step_id = ? AND direction = 'out' ORDER BY id ASC").all(stepId)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OutRowsSchema))
  )

// A resume carries checks and fixes only when it skips the implement step, so an implement step beside carried steps came from their run even when it names no log there.
const implementOrigin = (db: Database, runDir: string, runId: string): Effect.Effect<string | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => db.query("SELECT id, status FROM steps WHERE run_id = ? AND name != 'implement' ORDER BY id ASC").all(runId)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SiblingRowsSchema)),
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => outRows(db, row.id).pipe(Effect.map((out) => carriedFrom(runDir, { status: row.status, out }))))),
    Effect.map((origins) => origins.find((origin) => origin !== null) ?? null)
  )

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
    const stepRow = yield* sqlite(() => db.query("SELECT name, attempt, status FROM steps WHERE run_id = ? AND id = ?").get(runId, stepId))
    if (stepRow === null || stepRow === undefined) {
      return yield* new UnknownStep({ runId, step: stepId.toString() })
    }
    const step = yield* Schema.decodeUnknownEffect(StepRowSchema)(stepRow)
    const out = yield* outRows(db, stepId)
    const runDir = runDirOf(run.task_file)
    const own = carriedFrom(runDir, { ...step, out })
    const from = own === null && step.name === "implement" && step.status !== "running" ? yield* implementOrigin(db, runDir, runId) : own
    const file = stepLogFile(runDir, { ...step, out }, from)
    if (file === null) {
      return yield* new NoStepLog({ runId, stepId })
    }
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (cause) => cause.reason["_tag"] === "NotFound",
        () => step.status === "running" ? Effect.succeed("") : Effect.fail(new NoStepLog({ runId, stepId }))
      )
    )
  })
