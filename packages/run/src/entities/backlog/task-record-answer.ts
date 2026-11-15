import { Schema } from "effect"
import type { Answer } from "./task-record-decision"

export const deciderAnswerKinds = ["decider", "asked-back"] as const

interface RelayedAnswer extends Answer {
  readonly relayedTo: string | null
}

export interface DeciderAnswer extends RelayedAnswer {
  readonly by: typeof deciderAnswerKinds[number]
}

export interface CaptainAnswer extends RelayedAnswer {
  readonly by?: "captain"
  readonly overturned?: DeciderAnswer
}

export type ParkedAnswer = CaptainAnswer | DeciderAnswer

export const isDeciderAnswer = (answer: ParkedAnswer): answer is DeciderAnswer => answer.by !== undefined && answer.by !== "captain"

export const OverturnedFront = Schema.Struct({
  answer: Schema.String,
  answered_at: Schema.String,
  answered_by: Schema.Literals(deciderAnswerKinds),
  relayed_to: Schema.optional(Schema.String)
})

interface AnswerFront {
  readonly asked_at?: string | undefined
  readonly relayed_to?: string | undefined
  readonly used?: boolean | undefined
  readonly answered_by?: typeof deciderAnswerKinds[number] | undefined
  readonly overturned?: typeof OverturnedFront.Type | undefined
}

export const parkedAnswerOf = (question: AnswerFront, answer: Answer): ParkedAnswer => {
  const relayedTo = question.relayed_to ?? (question.used === true ? (question.asked_at ?? "") : null)
  if (question.answered_by !== undefined) {
    return { ...answer, relayedTo, by: question.answered_by }
  }
  const overturned = question.overturned
  return overturned === undefined
    ? { ...answer, relayedTo }
    : { ...answer, relayedTo, overturned: { words: overturned.answer, at: overturned.answered_at, by: overturned.answered_by, relayedTo: overturned.relayed_to ?? null } }
}
