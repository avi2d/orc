import { Schema } from "effect"
import { notRecordedBasis } from "../../shared/lib/index"
import { AttentionItem, Decision, decisionText, ItemAnswer } from "./attention-item"

export const DecidedEntry = Schema.Struct({
  id: Schema.String,
  kind: AttentionItem.fields.kind,
  task: Schema.String,
  text: Schema.String,
  asked: Schema.String,
  owner: AttentionItem.fields.owner,
  decision: Schema.optionalKey(Decision),
  answer: ItemAnswer,
  overturned: Schema.optionalKey(ItemAnswer)
})
export type DecidedEntry = typeof DecidedEntry.Type

export interface OwnerDecision {
  readonly id: string
  readonly task: string
  readonly question: string
  readonly words: string
  readonly replaced: boolean
  readonly inferred: boolean
}

interface AgentDecision extends OwnerDecision {
  readonly basis: string
}

interface DecisionGroups {
  readonly owner: ReadonlyArray<OwnerDecision>
  readonly agent: ReadonlyArray<AgentDecision>
}

const agentBasis = (decision: Decision | undefined): string => decision?.decider === "agent" ? decisionText(decision) : notRecordedBasis

const entryGroups = (entry: DecidedEntry): DecisionGroups => {
  const made = [
    ...(entry.overturned === undefined ? [] : [{ answer: entry.overturned, replaced: true }]),
    { answer: entry.answer, replaced: false }
  ].map(({ answer, replaced }) => ({
    decider: answer.decider,
    line: { id: entry.id, task: entry.task, question: entry.text, words: answer.words, replaced, inferred: answer.inferred === true }
  }))
  const agentAnswers = made.flatMap((entryMade) => entryMade.decider === "agent" ? [{ ...entryMade.line, basis: agentBasis(entry.decision) }] : [])
  const decision = entry.decision
  const agentWithoutAnswer = decision?.decider === "agent" && agentAnswers.length === 0
    ? [{ id: entry.id, task: entry.task, question: entry.text, words: decision.kind, replaced: false, inferred: false, basis: decisionText(decision) }]
    : []
  return {
    owner: made.flatMap((entryMade) => entryMade.decider === "owner" ? [entryMade.line] : []),
    agent: [...agentAnswers, ...agentWithoutAnswer]
  }
}

export const decisionGroups = (entries: ReadonlyArray<DecidedEntry>): DecisionGroups => {
  const each = entries.map(entryGroups)
  return { owner: each.flatMap((groups) => groups.owner), agent: each.flatMap((groups) => groups.agent) }
}
