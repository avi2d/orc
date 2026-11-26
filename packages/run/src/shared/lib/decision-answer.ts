import { Schema } from "effect"

export const Decider = Schema.Literals(["owner", "agent"])
export type Decider = typeof Decider.Type

export const AnswerWords = Schema.Struct({ words: Schema.String, at: Schema.String })
export const DecisionAnswer = Schema.Struct({ ...AnswerWords.fields, decider: Decider })

export const deciderLabel = (decider: Decider): string => decider === "owner" ? "Owner" : "Agent"

export const deciderHeadings = { owner: "Decided by the owner", agent: "Decided by the agent" } as const satisfies Record<Decider, string>

export const notRecordedBasis = "not recorded"

export const askBackWords = (question: string): string =>
  "Before it answers, orc's decider asks you: " + question + "\nPut your reply in a new orc_ask question."
