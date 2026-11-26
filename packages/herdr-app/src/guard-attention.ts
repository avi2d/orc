import { type Guard, type Guarded, absentOrString, arrayOf, child, fields, literal, number, ok, oneOf, pair, refused, string } from "./guard"

type Fields = Parameters<typeof string>[0]

interface AttentionOption {
  readonly text: string
  readonly outcome: string | null
  readonly picture: string | null
  readonly action: "write-answer" | "wait" | null
}

type Decider = "owner" | "agent"

interface Decision {
  readonly decider: Decider | null
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

interface Answer {
  readonly words: string
  readonly at: string
  readonly decider: Decider | null
  readonly inferred: boolean
}

export interface DecidedAttention extends AttentionEntry {
  readonly decision: Decision | null
  readonly answer: Answer
  readonly overturned: Answer | null
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

const withEntry = <T>(value: unknown, at: string, read: (record: Fields, entry: AttentionEntry) => Guarded<T>): Guarded<T> => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const entry = attentionEntry(record.value, at)
  return entry.kind === "refused" ? entry : read(record.value, entry.value)
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
  const action = record.value["action"] === undefined ? ok(null) : oneOf(record.value, "action", at, ["write-answer", "wait"] as const)
  if (action.kind === "refused") return action
  return ok({ text: text.value, outcome: outcome.value, picture: picture.value, action: action.value })
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

const readDecider = (record: Fields, at: string): Guarded<Decider | null> =>
  record["decider"] === undefined ? ok(null) : oneOf(record, "decider", at, ["owner", "agent"] as const)

const readDecision: Guard<Decision> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const kind = oneOf(record.value, "kind", at, ["answered", "escalated", "asked-back", "duplicate"] as const)
  if (kind.kind === "refused") return kind
  const basis = decisionBasis(record.value, at, kind.value)
  if (basis.kind === "refused") return basis
  const recommendation = absentOrString(record.value, "recommendation", at)
  if (recommendation.kind === "refused") return recommendation
  const decider = readDecider(record.value, at)
  return decider.kind === "refused" ? decider : ok({ kind: kind.value, basis: basis.value, recommendation: recommendation.value, decider: decider.value })
}

const attentionItem: Guard<AttentionItem> = (value, at) =>
  withEntry(value, at, (record, entry) => readItem(record, entry, at))

const readItem = (record: Fields, entry: AttentionEntry, at: string): Guarded<AttentionItem> => {
  const subject = absentOrString(record, "subject", at)
  if (subject.kind === "refused") return subject
  const options = record["options"] === undefined ? ok([]) : arrayOf(record, "options", at, attentionOption)
  if (options.kind === "refused") return options
  const recommendation = absentOrString(record, "recommendation", at)
  if (recommendation.kind === "refused") return recommendation
  const decision = record["decision"] === undefined ? ok(null) : readDecision(record["decision"], child(at, "decision"))
  if (decision.kind === "refused") return decision
  const age = number(record, "ageSeconds", at)
  if (age.kind === "refused") return age
  if (!Number.isSafeInteger(age.value) || age.value < 0) return refused(child(at, "ageSeconds"), "a non-negative integer", age.value)
  const overdue = record["overdue"]
  if (typeof overdue !== "boolean") return refused(child(at, "overdue"), "a boolean", overdue)
  return ok({ ...entry, subject: subject.value, options: options.value, recommendation: recommendation.value, decision: decision.value, overdueSeconds: overdue ? age.value : null })
}

const readAnswer: Guard<Answer> = (value, path) => {
  const record = fields(value, path)
  if (record.kind === "refused") return record
  const content = pair(record.value, path, "words", "at", (words, at) => ({ words, at }))
  if (content.kind === "refused") return content
  const decider = readDecider(record.value, path)
  if (decider.kind === "refused") return decider
  const inferred = record.value["inferred"]
  if (inferred !== undefined && inferred !== true) return refused(child(path, "inferred"), "true", inferred)
  return ok({ ...content.value, decider: decider.value, inferred: inferred === true })
}

const decidedItem: Guard<DecidedAttention> = (value, at) =>
  withEntry(value, at, (record, entry) => readDecided(record, entry, at))

const readDecided = (record: Fields, entry: AttentionEntry, at: string): Guarded<DecidedAttention> => {
  const decision = record["decision"] === undefined ? ok(null) : readDecision(record["decision"], child(at, "decision"))
  if (decision.kind === "refused") return decision
  const answer = readAnswer(record["answer"], child(at, "answer"))
  if (answer.kind === "refused") return answer
  const overturned = record["overturned"] === undefined ? ok(null) : readAnswer(record["overturned"], child(at, "overturned"))
  if (overturned.kind === "refused") return overturned
  return ok({ ...entry, decision: decision.value, answer: answer.value, overturned: overturned.value })
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
