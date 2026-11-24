import { type Guard, absentOrString, arrayOf, child, fields, literal, number, ok, pair, runsHead, string } from "./guard"

export interface AttentionItem {
  readonly id: string
  readonly kind: string
  readonly task: string
  readonly escalated: boolean
  readonly recommendation: string | null
}

const attentionItem: Guard<AttentionItem> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const named = pair(record.value, at, "id", "kind", (id, kind) => ({ id, kind }))
  if (named.kind === "refused") return named
  const taskId = string(record.value, "task", at)
  if (taskId.kind === "refused") return taskId
  const decision = record.value["decision"]
  if (decision === undefined) return ok({ ...named.value, task: taskId.value, escalated: false, recommendation: null })
  const decided = fields(decision, child(at, "decision"))
  if (decided.kind === "refused") return decided
  const kind = string(decided.value, "kind", child(at, "decision"))
  if (kind.kind === "refused") return kind
  const recommendation = absentOrString(decided.value, "recommendation", child(at, "decision"))
  if (recommendation.kind === "refused") return recommendation
  return ok({ ...named.value, task: taskId.value, escalated: kind.value === "escalated", recommendation: recommendation.value })
}

export const attention: Guard<ReadonlyArray<AttentionItem>> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.attention.v1")
  return schema.kind === "refused" ? schema : arrayOf(record.value, "items", at, attentionItem)
}

export interface AskingRun {
  readonly branch: string
  readonly task: string | null
  readonly questions: number
}

const askingRun: Guard<AskingRun> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const taskId = absentOrString(record.value, "task", at)
  if (taskId.kind === "refused") return taskId
  const branch = string(record.value, "branch", at)
  if (branch.kind === "refused") return branch
  const questions = number(record.value, "questions", at)
  if (questions.kind === "refused") return questions
  return ok({ branch: branch.value, task: taskId.value, questions: questions.value })
}

export const askingRuns: Guard<ReadonlyArray<AskingRun>> = (value, at) => {
  const head = runsHead(value, at)
  return head.kind === "refused" ? head : arrayOf(head.value.record, "runs", at, askingRun)
}
