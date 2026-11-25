import { type Guard, type Guarded, absentOrString, arrayOf, child, fields, literal, number, ok, oneOf, pair, refused, string } from "./guard"

type Fields = Parameters<typeof string>[0]

interface AttentionOption {
  readonly text: string
  readonly outcome: string | null
  readonly picture: string | null
}

interface Decision {
  readonly kind: "answered" | "escalated" | "asked-back" | "duplicate"
  readonly basis: string
  readonly recommendation: string | null
}

interface AttentionEntry {
  readonly id: string
  readonly kind: string
  readonly task: string
  readonly text: string
  readonly owner: "user" | "decider"
  readonly asked: string
}

export interface AttentionItem extends AttentionEntry {
  readonly subject: string | null
  readonly options: ReadonlyArray<AttentionOption>
  readonly recommendation: string | null
  readonly decision: Decision | null
  readonly overdueSeconds: number | null
}

export interface DecidedAttention extends AttentionEntry {
  readonly decision: Decision
  readonly answer: string
  readonly overturned: string | null
}

export interface AttentionQueue {
  readonly items: ReadonlyArray<AttentionItem>
  readonly decided: ReadonlyArray<DecidedAttention>
}

const attentionEntry = (record: Fields, at: string): Guarded<AttentionEntry> => {
  const named = pair(record, at, "id", "kind", (id, kind) => ({ id, kind }))
  if (named.kind === "refused") return named
  const content = pair(record, at, "task", "text", (task, text) => ({ task, text }))
  if (content.kind === "refused") return content
  const owner = oneOf(record, "owner", at, ["user", "decider"] as const)
  if (owner.kind === "refused") return owner
  const asked = string(record, "asked", at)
  if (asked.kind === "refused") return asked
  return ok({ ...named.value, ...content.value, owner: owner.value, asked: asked.value })
}

const attentionOption: Guard<AttentionOption> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const text = string(record.value, "text", at)
  if (text.kind === "refused") return text
  const outcome = absentOrString(record.value, "outcome", at)
  if (outcome.kind === "refused") return outcome
  const picture = absentOrString(record.value, "picture", at)
  if (picture.kind === "refused") return picture
  return ok({ text: text.value, outcome: outcome.value, picture: picture.value })
}

const decisionBasis = (record: Fields, at: string, kind: Decision["kind"]): Guarded<string> => {
  if (kind === "asked-back") {
    const question = string(record, "question", at)
    return question.kind === "ok" ? ok(`Asked the worker: ${question.value}`) : question
  }
  if (kind === "duplicate") {
    const of = string(record, "of", at)
    return of.kind === "ok" ? ok(`Same question as ${of.value}`) : of
  }
  const reason = string(record, "reason", at)
  if (reason.kind === "refused" || record["rule"] === undefined) return reason
  const ruleAt = child(at, "rule")
  const rule = fields(record["rule"], ruleAt)
  if (rule.kind === "refused") return rule
  return pair(rule.value, ruleAt, "source", "quote", (source, quote) => `${reason.value}\n${source}: “${quote}”`)
}

const readDecision: Guard<Decision> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const kind = oneOf(record.value, "kind", at, ["answered", "escalated", "asked-back", "duplicate"] as const)
  if (kind.kind === "refused") return kind
  const basis = decisionBasis(record.value, at, kind.value)
  if (basis.kind === "refused") return basis
  const recommendation = absentOrString(record.value, "recommendation", at)
  if (recommendation.kind === "refused") return recommendation
  return ok({ kind: kind.value, basis: basis.value, recommendation: recommendation.value })
}

const attentionItem: Guard<AttentionItem> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const entry = attentionEntry(record.value, at)
  if (entry.kind === "refused") return entry
  const subject = absentOrString(record.value, "subject", at)
  if (subject.kind === "refused") return subject
  const options = record.value["options"] === undefined ? ok([]) : arrayOf(record.value, "options", at, attentionOption)
  if (options.kind === "refused") return options
  const recommendation = absentOrString(record.value, "recommendation", at)
  if (recommendation.kind === "refused") return recommendation
  const decision = record.value["decision"] === undefined ? ok(null) : readDecision(record.value["decision"], child(at, "decision"))
  if (decision.kind === "refused") return decision
  const age = number(record.value, "ageSeconds", at)
  if (age.kind === "refused") return age
  if (!Number.isSafeInteger(age.value) || age.value < 0) return refused(child(at, "ageSeconds"), "a non-negative integer", age.value)
  const overdue = record.value["overdue"]
  if (typeof overdue !== "boolean") return refused(child(at, "overdue"), "a boolean", overdue)
  return ok({ ...entry.value, subject: subject.value, options: options.value, recommendation: recommendation.value, decision: decision.value, overdueSeconds: overdue ? age.value : null })
}

const answerWords: Guard<string> = (value, at) => {
  const record = fields(value, at)
  return record.kind === "ok" ? string(record.value, "words", at) : record
}

const decidedItem: Guard<DecidedAttention> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const entry = attentionEntry(record.value, at)
  if (entry.kind === "refused") return entry
  const decision = readDecision(record.value["decision"], child(at, "decision"))
  if (decision.kind === "refused") return decision
  const answer = answerWords(record.value["answer"], child(at, "answer"))
  if (answer.kind === "refused") return answer
  const overturned = record.value["overturned"] === undefined ? ok(null) : answerWords(record.value["overturned"], child(at, "overturned"))
  if (overturned.kind === "refused") return overturned
  return ok({ ...entry.value, decision: decision.value, answer: answer.value, overturned: overturned.value })
}

export const attention: Guard<AttentionQueue> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.attention.v1")
  if (schema.kind === "refused") return schema
  const items = arrayOf(record.value, "items", at, attentionItem)
  if (items.kind === "refused") return items
  const decided = record.value["decided"] === undefined ? ok([]) : arrayOf(record.value, "decided", at, decidedItem)
  return decided.kind === "refused" ? decided : ok({ items: items.value, decided: decided.value })
}
