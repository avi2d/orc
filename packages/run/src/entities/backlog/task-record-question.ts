import { Schema } from "effect"
import type { ParkedAnswer } from "./task-record-answer"

const ParkedOption = Schema.Struct({ text: Schema.String, outcome: Schema.optional(Schema.String), picture: Schema.optional(Schema.String), action: Schema.optional(Schema.Literals(["write-answer", "wait"])) })
type ParkedOption = typeof ParkedOption.Type

export const ChoicesFront = {
  subject: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(ParkedOption)),
  recommendation: Schema.optional(Schema.String),
  asks: Schema.optional(Schema.String)
}

interface ParkedChoices {
  readonly subject?: string | undefined
  readonly options?: ReadonlyArray<ParkedOption> | undefined
  readonly recommendation?: string | undefined
  readonly asks?: string | undefined
}

export interface ParkedQuestion extends ParkedChoices {
  readonly id: string
  readonly text: string
  readonly asked: string
  readonly blocks: boolean
  readonly answer: ParkedAnswer | null
  readonly owner?: "user" | undefined
}

export const choicesOf = (question: ParkedChoices): ParkedChoices => ({
  ...(question.subject === undefined ? {} : { subject: question.subject }),
  ...(question.options === undefined ? {} : { options: question.options }),
  ...(question.recommendation === undefined ? {} : { recommendation: question.recommendation }),
  ...(question.asks === undefined ? {} : { asks: question.asks })
})
