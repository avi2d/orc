import { Schema } from "effect"
import { Decider } from "../../shared/lib/index"

export const AskOption = Schema.Struct({ text: Schema.String, outcome: Schema.optional(Schema.String), picture: Schema.optional(Schema.String), action: Schema.optional(Schema.Literals(["write-answer", "wait"])) })

export type AskOption = typeof AskOption.Type

export const OpenQuestion = Schema.Struct({
  id: Schema.String,
  subject: Schema.optional(Schema.String),
  asking: Schema.optional(Schema.String),
  text: Schema.String,
  options: Schema.optional(Schema.Array(AskOption)),
  recommendation: Schema.optional(Schema.String),
  asks: Schema.optional(Schema.String),
  blocks: Schema.optional(Schema.Boolean),
  asked: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.Literal("user"))
})

export type OpenQuestion = typeof OpenQuestion.Type

export type QuestionContext = Pick<OpenQuestion, "subject" | "options" | "recommendation">

export const findingContext = (step: string, id: string, description: string): QuestionContext => ({
  subject: "Review finding " + id + " at the " + step + " gate",
  options: [
    { text: "Write an answer", action: "write-answer", outcome: description.trim() === "" ? "Record instructions for the reviewer to use on the next run." : "Record how the next run should handle this finding: " + description },
    { text: "Leave open", action: "wait", outcome: "Do not answer the finding. The run cannot clear this gate yet." }
  ],
  recommendation: "Write an answer"
})

export const QuestionAnswer = Schema.Struct({
  question: Schema.String.check(Schema.isPattern(/^[^\s=]+$/)),
  answer: Schema.String.check(Schema.isNonEmpty()),
  decider: Schema.optional(Decider)
})
export type QuestionAnswer = typeof QuestionAnswer.Type
