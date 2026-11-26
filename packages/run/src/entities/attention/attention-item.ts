import { Schema } from "effect"
import { AnswerWords, Decider, DecisionAnswer } from "../../shared/lib/index"

const AttentionOption = Schema.Struct({
  text: Schema.String,
  outcome: Schema.optionalKey(Schema.String),
  picture: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.Literals(["write-answer", "wait"]))
})
export const ItemAnswer = Schema.Struct({ ...DecisionAnswer.fields, inferred: Schema.optionalKey(Schema.Literal(true)) })
const QuotedRule = Schema.Struct({ quote: Schema.String, source: Schema.String })

const answered = { kind: Schema.Literal("answered"), reason: Schema.String, rule: Schema.optionalKey(QuotedRule), at: Schema.String }
const escalated = { kind: Schema.Literal("escalated"), reason: Schema.String, recommendation: Schema.optionalKey(Schema.String), at: Schema.String }
const askedBack = { kind: Schema.Literal("asked-back"), question: Schema.String, at: Schema.String }
const duplicate = { kind: Schema.Literal("duplicate"), of: Schema.String, at: Schema.String }

export const Decision = Schema.Union([
  Schema.Struct({ ...answered, decider: Decider }),
  Schema.Struct({ ...escalated, decider: Decider }),
  Schema.Struct({ ...askedBack, decider: Decider }),
  Schema.Struct({ ...duplicate, decider: Decider })
])

const StoredDecision = Schema.Union([
  Schema.Struct({ ...answered, decider: Schema.optionalKey(Decider) }),
  Schema.Struct({ ...escalated, decider: Schema.optionalKey(Decider) }),
  Schema.Struct({ ...askedBack, decider: Schema.optionalKey(Decider) }),
  Schema.Struct({ ...duplicate, decider: Schema.optionalKey(Decider) })
])

const QuestionKind = Schema.Literals(["review-question", "worker-question", "overdue-wait", "unasked-question"])
const EventKind = Schema.Literals(["run-died", "check-red", "pr-ready", "pr-closed", "failing-command", "machine-unreached", "update-failed"])

const askedFields = {
  task: Schema.String,
  text: Schema.String,
  subject: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(AttentionOption)),
  recommendation: Schema.optionalKey(Schema.String),
  asked: Schema.String,
  owner: Schema.Literals(["decider", "user"])
}

const flags = { deciding: Schema.optionalKey(Schema.Struct({ at: Schema.String })) }
const Open = Schema.Struct({ kind: Schema.Literal("open") })
const Withdrawn = Schema.Struct({ kind: Schema.Literal("withdrawn"), reason: Schema.String, at: Schema.String })

export const AttentionItem = Schema.Struct({
  ...askedFields,
  kind: Schema.Union([QuestionKind, EventKind]),
  ...flags,
  decision: Schema.optionalKey(Decision),
  state: Schema.Union([
    Open,
    Schema.Struct({ kind: Schema.Literal("closed"), answer: ItemAnswer, overturned: Schema.optionalKey(ItemAnswer) }),
    Withdrawn
  ])
})

const StoredAnswer = Schema.Struct({ ...AnswerWords.fields, decider: Schema.optionalKey(Decider), inferred: ItemAnswer.fields.inferred })

export const StoredAttentionItem = Schema.Struct({
  ...AttentionItem.fields,
  decision: Schema.optionalKey(StoredDecision),
  state: Schema.Union([
    Open,
    Schema.Struct({ kind: Schema.Literal("closed"), answer: StoredAnswer, overturned: Schema.optionalKey(StoredAnswer) }),
    Withdrawn
  ])
})

const NonBlank = Schema.String.check(Schema.isPattern(/\S/))
const QuestionOption = Schema.Struct({ ...AttentionOption.fields, text: NonBlank, outcome: NonBlank })
const questionChoiceFields = {
  subject: NonBlank,
  options: Schema.NonEmptyArray(QuestionOption),
  recommendation: NonBlank
}
const recommendsOption = Schema.makeFilter(({ options, recommendation }: { readonly options: ReadonlyArray<{ readonly text: string }>; readonly recommendation: string }) =>
  options.some((option) => option.text === recommendation) || "recommendation must name a listed option")

export const isQuestionChoice = Schema.is(Schema.Struct(questionChoiceFields).check(recommendsOption))

export const NewItem = Schema.Union([
  Schema.Struct({ ...askedFields, ...questionChoiceFields, kind: QuestionKind, task: NonBlank, text: NonBlank }).check(recommendsOption),
  Schema.Struct({ ...askedFields, kind: EventKind })
])

export type AttentionItem = typeof AttentionItem.Type
export type Asked = Omit<AttentionItem, "state" | "decision" | "deciding">
export type AttentionOption = typeof AttentionOption.Type
export type ItemAnswer = typeof ItemAnswer.Type
export type Decision = typeof Decision.Type

export const decisionText = (decision: Decision): string => {
  switch (decision.kind) {
    case "answered": {
      return decision.rule === undefined ? decision.reason : decision.reason + ", quoting " + decision.rule.source + ": " + JSON.stringify(decision.rule.quote)
    }
    case "escalated": {
      return decision.reason
    }
    case "asked-back": {
      return "asked the worker back: " + decision.question
    }
    case "duplicate": {
      return "the same question as " + decision.of
    }
  }
}
