import { Schema } from "effect"
import { AskOption } from "../review-gate/index"

const Answer = Schema.Struct({ words: Schema.String, at: Schema.String })

const QuotedRule = Schema.Struct({ quote: Schema.String, source: Schema.String })

export const Decision = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("answered"), reason: Schema.String, rule: Schema.optionalKey(QuotedRule), at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("escalated"), reason: Schema.String, at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("asked-back"), question: Schema.String, at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("duplicate"), of: Schema.String, at: Schema.String })
])

export const AttentionItem = Schema.Struct({
  kind: Schema.Literals(["review-question", "worker-question", "run-died", "check-red", "pr-ready", "overdue-wait", "failing-command"]),
  task: Schema.String,
  text: Schema.String,
  options: Schema.optionalKey(Schema.Array(AskOption)),
  asked: Schema.String,
  owner: Schema.Literals(["decider", "user"]),
  decision: Schema.optionalKey(Decision),
  deciding: Schema.optionalKey(Schema.Struct({ at: Schema.String })),
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("open") }),
    Schema.Struct({ kind: Schema.Literal("closed"), answer: Answer, overturned: Schema.optionalKey(Answer) }),
    Schema.Struct({ kind: Schema.Literal("withdrawn"), reason: Schema.String, at: Schema.String })
  ])
})

export type AttentionItem = typeof AttentionItem.Type
export type Asked = Omit<AttentionItem, "state" | "decision" | "deciding">
export type ItemAnswer = typeof Answer.Type
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
