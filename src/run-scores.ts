import type { Database } from "bun:sqlite"
import { Data, Effect, Schema } from "effect"
import { ScoreValueSchema, recordScore, sqlite, type SqliteFailure } from "./run-history"

export class UnknownRun extends Data.TaggedError("UnknownRun")<{
  readonly runId: string
}> {}

export class UnknownStep extends Data.TaggedError("UnknownStep")<{
  readonly runId: string
  readonly step: string
}> {}

export class InvalidScore extends Data.TaggedError("InvalidScore")<{
  readonly score: number
}> {}

export interface StepScoreInput {
  readonly runId: string
  readonly step: string
  readonly score: number
  readonly note: string
  readonly scoredAt: string
}

const StepIdRowSchema = Schema.Struct({ id: Schema.Finite })

const selectStep = (step: string): { readonly name: string; readonly attempt: number | null } => {
  const hash = step.lastIndexOf("#")
  if (hash <= 0 || hash === step.length - 1) {
    return { name: step, attempt: null }
  }
  const name = step.slice(0, hash)
  const attemptText = step.slice(hash + 1)
  if (!/^[1-9][0-9]*$/.test(attemptText)) {
    return { name: step, attempt: null }
  }
  return { name, attempt: Number(attemptText) }
}

export const recordStepScore = (
  db: Database,
  input: StepScoreInput
): Effect.Effect<number, SqliteFailure | Schema.SchemaError | UnknownRun | UnknownStep | InvalidScore> =>
  Effect.gen(function*() {
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      return yield* new InvalidScore({ score: input.score })
    }
    const runRow = yield* sqlite(() => db.query("SELECT id FROM runs WHERE id = ?").get(input.runId))
    if (runRow === null || runRow === undefined) {
      return yield* new UnknownRun({ runId: input.runId })
    }
    if (/^[1-9][0-9]*$/.test(input.step)) {
      const wanted = Number(input.step)
      const byId = yield* sqlite(() =>
        db.query("SELECT id FROM steps WHERE run_id = ? AND id = ? LIMIT 1").get(input.runId, wanted)
      )
      if (byId === null || byId === undefined) {
        return yield* new UnknownStep({ runId: input.runId, step: input.step })
      }
      const byIdStepId = (yield* Schema.decodeUnknownEffect(StepIdRowSchema)(byId)).id
      const byIdScore = yield* Schema.decodeUnknownEffect(ScoreValueSchema)(input.score).pipe(
        Effect.mapError(() => new InvalidScore({ score: input.score }))
      )
      return yield* recordScore(db, { stepId: byIdStepId, score: byIdScore, note: input.note, scoredAt: input.scoredAt })
    }
    const selector = selectStep(input.step)
    if (selector.attempt !== null) {
      const attemptRow = yield* sqlite(() =>
        db.query("SELECT id FROM steps WHERE run_id = ? AND name = ? AND attempt = ? ORDER BY started DESC, id DESC LIMIT 1").get(input.runId, selector.name, selector.attempt)
      )
      if (attemptRow === null || attemptRow === undefined) {
        return yield* new UnknownStep({ runId: input.runId, step: input.step })
      }
      const attemptStepId = (yield* Schema.decodeUnknownEffect(StepIdRowSchema)(attemptRow)).id
      const attemptScore = yield* Schema.decodeUnknownEffect(ScoreValueSchema)(input.score).pipe(
        Effect.mapError(() => new InvalidScore({ score: input.score }))
      )
      return yield* recordScore(db, { stepId: attemptStepId, score: attemptScore, note: input.note, scoredAt: input.scoredAt })
    }
    const stepRow = yield* sqlite(() =>
      db.query("SELECT id FROM steps WHERE run_id = ? AND name = ? ORDER BY started DESC, id DESC LIMIT 1").get(input.runId, selector.name)
    )
    if (stepRow === null || stepRow === undefined) {
      return yield* new UnknownStep({ runId: input.runId, step: input.step })
    }
    const stepId = (yield* Schema.decodeUnknownEffect(StepIdRowSchema)(stepRow)).id
    const score = yield* Schema.decodeUnknownEffect(ScoreValueSchema)(input.score).pipe(
      Effect.mapError(() => new InvalidScore({ score: input.score }))
    )
    return yield* recordScore(db, { stepId, score, note: input.note, scoredAt: input.scoredAt })
  })
