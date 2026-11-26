import { type Decider, DecisionAnswer } from "../../shared/lib/index"

export const answeredReason = "answered"

export const Answer = DecisionAnswer

export type Answer = typeof Answer.Type

export interface AnsweredClosing {
  readonly outcome: "done"
  readonly reason: typeof answeredReason
  readonly answer: Answer
}

interface AnswerFront {
  readonly answer?: string | undefined
  readonly answered_at?: string | undefined
  readonly decider?: Decider | undefined
}

export const answerOf = (front: AnswerFront, legacyDecider: Decider): Answer | null | string => {
  if (front.answer === undefined && front.answered_at === undefined && front.decider === undefined) {
    return null
  }
  if (front.answer === undefined || front.answered_at === undefined || Number.isNaN(Date.parse(front.answered_at))) {
    return "an answer names no words or no time"
  }
  return { words: front.answer, at: front.answered_at, decider: front.decider ?? legacyDecider }
}

export interface DecisionFront extends AnswerFront {
  readonly reason?: string | undefined
  readonly closed_at?: string | undefined
  readonly outcome?: string | undefined
  readonly posted_at?: string | undefined
}

const answeredOf = (front: DecisionFront): { readonly kind: "closed"; readonly claim: null; readonly closing: AnsweredClosing; readonly closedAt: string; readonly postedAt: string | null } | string => {
  const answer = answerOf(front, "owner")
  if (answer === null || typeof answer === "string" || front.reason !== answeredReason || front.closed_at === undefined) {
    return "a closed decision names no answer, answer time or close time"
  }
  return { kind: "closed", claim: null, closing: { outcome: "done", reason: answeredReason, answer }, closedAt: front.closed_at, postedAt: front.posted_at ?? null }
}

export const decisionStateOf = <F extends DecisionFront, S>(folder: "new" | "taken" | "closed", front: F, fallback: (folder: "new" | "taken" | "closed", front: F) => S | string): S | { readonly kind: "closed"; readonly claim: null; readonly closing: AnsweredClosing; readonly closedAt: string; readonly postedAt: string | null } | string => {
  if (folder === "taken") {
    return "a decision is never taken, since no run answers it"
  }
  return folder === "closed" && front.outcome === "done" ? answeredOf(front) : fallback(folder, front)
}
