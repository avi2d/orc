import { Schema } from "effect"
import type { ParkedAnswer } from "./task-record-answer"

const ParkedOption = Schema.Struct({ text: Schema.String, outcome: Schema.optional(Schema.String), picture: Schema.optional(Schema.String) })
type ParkedOption = typeof ParkedOption.Type

export const ChoicesFront = {
  options: Schema.optional(Schema.Array(ParkedOption)),
  recommendation: Schema.optional(Schema.String),
  asks: Schema.optional(Schema.String)
}

interface ParkedChoices {
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
}

export const choicesOf = (question: ParkedChoices): ParkedChoices => ({
  ...(question.options === undefined ? {} : { options: question.options }),
  ...(question.recommendation === undefined ? {} : { recommendation: question.recommendation }),
  ...(question.asks === undefined ? {} : { asks: question.asks })
})
