import type { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import {
  EvidenceDirectionSchema,
  RunStatusSchema,
  RunSqlRowSchema,
  ScoreValueSchema,
  SHOW_JSON_SCHEMA,
  sqlite,
  StepStatusSchema,
  toFileUrl,
  type SqliteFailure
} from "./run-history"
import { reportFileName } from "./report"

const ShowSignalSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String
})

const ShowEvidenceSchema = Schema.Struct({
  direction: EvidenceDirectionSchema,
  path: Schema.String,
  kind: Schema.String,
  fileUrl: Schema.String
})

const ShowScoreSchema = Schema.Struct({
  score: ScoreValueSchema,
  note: Schema.String,
  scoredAt: Schema.String
})

const ShowStepSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  attempt: Schema.Number,
  status: StepStatusSchema,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  agentFile: Schema.NullOr(Schema.String),
  piSessionFile: Schema.NullOr(Schema.String),
  signals: Schema.Array(ShowSignalSchema),
  score: Schema.NullOr(ShowScoreSchema),
  evidence: Schema.Array(ShowEvidenceSchema)
})

const ShowRunSchema = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  status: RunStatusSchema,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  prLink: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(Schema.String),
  taskFile: Schema.String,
  taskFileUrl: Schema.String,
  report: Schema.String,
  reportUrl: Schema.String
})

const ShowJsonSchema = Schema.Struct({
  schema: Schema.Literal(SHOW_JSON_SCHEMA),
  run: ShowRunSchema,
  steps: Schema.Array(ShowStepSchema)
})

export type ShowJsonDocument = typeof ShowJsonSchema.Type

export const encodeShowJson = (document: ShowJsonDocument): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(ShowJsonSchema)(document).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeShowJson = (value: unknown): Effect.Effect<ShowJsonDocument, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ShowJsonSchema)(value)

const StepSqlRowSchema = Schema.Struct({
  id: Schema.Number,
  run_id: Schema.String,
  name: Schema.String,
  attempt: Schema.Number,
  status: StepStatusSchema,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  agent_file: Schema.NullOr(Schema.String),
  pi_session_file: Schema.NullOr(Schema.String)
})

const EvidenceSqlRowSchema = Schema.Struct({
  step_id: Schema.Number,
  direction: EvidenceDirectionSchema,
  path: Schema.String,
  kind: Schema.String
})

const SignalSqlRowSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String
})

const ScoreSqlRowSchema = Schema.Struct({
  score: ScoreValueSchema,
  note: Schema.String,
  scored_at: Schema.String
})

const reportPathForRunDir = (runDir: string): string => runDir + "/" + reportFileName

export const readShow = (
  db: Database,
  runId: string
): Effect.Effect<ShowJsonDocument | null, Schema.SchemaError | SqliteFailure> =>
  sqlite(() => ({
    run: db.query(
      "SELECT id, project, branch, task_file, status, started, ended, pr_link, end_reason FROM runs WHERE id = ?"
    ).get(runId),
    steps: db.query(
      "SELECT id, run_id, name, attempt, status, started, ended, agent_file, pi_session_file FROM steps WHERE run_id = ? ORDER BY id ASC"
    ).all(runId)
  })).pipe(
    Effect.flatMap(({ run, steps }) =>
      Effect.gen(function*() {
        if (run === null || run === undefined) {
          return null
        }
        const runRow = yield* Schema.decodeUnknownEffect(RunSqlRowSchema)(run)
        const stepRows = yield* Schema.decodeUnknownEffect(Schema.Array(StepSqlRowSchema))(steps)
        const detailed = []
        for (const step of stepRows) {
          const [evidenceRows, signalRows, scoreRow] = yield* sqlite(() => [
            db.query("SELECT step_id, direction, path, kind FROM evidence WHERE step_id = ? ORDER BY id ASC").all(step.id),
            db.query("SELECT name, value FROM signals WHERE step_id = ? ORDER BY id ASC").all(step.id),
            db.query("SELECT score, note, scored_at FROM scores WHERE step_id = ? ORDER BY id DESC LIMIT 1").get(step.id)
          ])
          const evidence = yield* Schema.decodeUnknownEffect(Schema.Array(EvidenceSqlRowSchema))(evidenceRows)
          const signals = yield* Schema.decodeUnknownEffect(Schema.Array(SignalSqlRowSchema))(signalRows)
          const score = scoreRow === null || scoreRow === undefined
            ? null
            : yield* Schema.decodeUnknownEffect(ScoreSqlRowSchema)(scoreRow)
          detailed.push({
            id: step.id,
            name: step.name,
            attempt: step.attempt,
            status: step.status,
            started: step.started,
            ended: step.ended,
            agentFile: step.agent_file,
            piSessionFile: step.pi_session_file,
            signals: signals.map((signal) => ({ name: signal.name, value: signal.value })),
            score: score === null ? null : { score: score.score, note: score.note, scoredAt: score.scored_at },
            evidence: evidence.map((item) => ({
              direction: item.direction,
              path: item.path,
              kind: item.kind,
              fileUrl: toFileUrl(item.path)
            }))
          })
        }
        const separator = runRow.task_file.lastIndexOf("/")
        const runDir = separator < 0 ? "." : runRow.task_file.slice(0, separator)
        const report = reportPathForRunDir(runDir)
        return yield* Schema.decodeUnknownEffect(ShowJsonSchema)({
          schema: SHOW_JSON_SCHEMA,
          run: {
            id: runRow.id,
            project: runRow.project,
            branch: runRow.branch,
            status: runRow.status,
            started: runRow.started,
            ended: runRow.ended,
            prLink: runRow.pr_link,
            endReason: runRow.end_reason,
            taskFile: runRow.task_file,
            taskFileUrl: toFileUrl(runRow.task_file),
            report,
            reportUrl: toFileUrl(report)
          },
          steps: detailed
        })
      })
    )
  )

export const formatShow = (document: ShowJsonDocument): string => {
  const lines: Array<string> = [
    "run " + document.run.id,
    "project: " + document.run.project,
    "branch: " + document.run.branch,
    "status: " + document.run.status,
    "pr: " + (document.run.prLink ?? "none"),
    "task: " + document.run.taskFileUrl,
    "report: " + document.run.reportUrl
  ]
  if (document.run.endReason !== null) {
    lines.push("ended: " + document.run.endReason)
  }
  for (const step of document.steps) {
    lines.push("")
    lines.push("step " + step.name + " #" + step.attempt.toString() + ": " + step.status)
    lines.push("  agent: " + (step.agentFile ?? "none"))
    lines.push("  session: " + (step.piSessionFile === null ? "none" : toFileUrl(step.piSessionFile)))
    for (const signal of step.signals) {
      lines.push("  signal " + signal.name + ": " + signal.value)
    }
    lines.push(scoreLine(step.score))
    if (step.evidence.length === 0) {
      lines.push("  evidence: none")
    }
    for (const item of step.evidence) {
      lines.push("  evidence " + item.direction + " " + item.kind + ": " + item.fileUrl)
    }
  }
  return lines.join("\n")
}

const scoreLine = (score: ShowJsonDocument["steps"][number]["score"]): string =>
  "  score: " + (score === null ? "none" : score.score.toString() + " " + score.note + " (" + score.scoredAt + ")")
