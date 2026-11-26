import { Schema } from "effect"
import { AnswerWords, Decider } from "../../shared/lib/index"
import { Answer } from "./task-record-decision"

const HoldQuestion = Schema.Struct({ id: Schema.String, text: Schema.String, answer: Schema.NullOr(Answer) })
export type HoldQuestion = typeof HoldQuestion.Type

const AnsweredHold = Schema.Struct({
  reason: Schema.String,
  until: Schema.NullOr(Schema.String),
  questions: Schema.Array(HoldQuestion),
  answer: Answer,
  at: Schema.optional(Schema.String),
  repeat: Schema.optional(Schema.Boolean)
})

export type AnsweredHold = typeof AnsweredHold.Type

const StoredHoldAnswer = Schema.Struct({ ...AnswerWords.fields, decider: Schema.optionalKey(Decider) })
type StoredHoldAnswer = typeof StoredHoldAnswer.Type
export const StoredAnsweredHold = Schema.Struct({
  ...AnsweredHold.fields,
  questions: Schema.Array(Schema.Struct({ ...HoldQuestion.fields, answer: Schema.NullOr(StoredHoldAnswer) })),
  answer: StoredHoldAnswer
})

const migrateHeldAnswer = (answer: StoredHoldAnswer): Answer => ({ ...answer, decider: answer.decider ?? "owner" })
export const migrateHold = (hold: typeof StoredAnsweredHold.Type): AnsweredHold => ({
  ...hold,
  questions: hold.questions.map((question) => ({ ...question, answer: question.answer === null ? null : migrateHeldAnswer(question.answer) })),
  answer: migrateHeldAnswer(hold.answer)
})
