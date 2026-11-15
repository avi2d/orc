import { type Guard, type Guarded, arrayOf, boardKinds, child, fields, literal, nullableString, number, ok, oneOf, prStates, refused, string } from "./guard"
import type { Answer, Asked, HoldRecord, TaskDetail, TaskHold, TaskParked, TaskRun, TaskState } from "./task"

type Fields = Readonly<Record<string, unknown>>

const nullable = <A>(record: Fields, name: string, at: string, guard: Guard<A>): Guarded<A | null> =>
  record[name] === null ? ok(null) : guard(record[name], child(at, name))

const absentOr = <A>(record: Fields, name: string, at: string, guard: Guard<A | null>): Guarded<A | null> =>
  record[name] === undefined ? ok(null) : guard(record[name], child(at, name))

const words: Guard<string> = (value, at) => typeof value === "string" ? ok(value) : refused(at, "a string", value)

const answer: Guard<Answer> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const said = string(record.value, "words", at)
  if (said.kind === "refused") return said
  const when = string(record.value, "at", at)
  return when.kind === "refused" ? when : ok({ words: said.value, at: when.value })
}

const asked: Guard<Asked> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const id = string(record.value, "id", at)
  if (id.kind === "refused") return id
  const text = string(record.value, "text", at)
  if (text.kind === "refused") return text
  const when = record.value["asked"] === undefined ? ok(null) : string(record.value, "asked", at)
  if (when.kind === "refused") return when
  const given = nullable(record.value, "answer", at, answer)
  return given.kind === "refused" ? given : ok({ id: id.value, text: text.value, asked: when.value, answer: given.value })
}

const holdRecord: Guard<HoldRecord> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const reason = string(record.value, "reason", at)
  if (reason.kind === "refused") return reason
  const until = absentOr(record.value, "until", at, (entry, where) => entry === null ? ok(null) : words(entry, where))
  if (until.kind === "refused") return until
  const when = absentOr(record.value, "at", at, (entry, where) => entry === null ? ok(null) : words(entry, where))
  if (when.kind === "refused") return when
  const questions = arrayOf(record.value, "questions", at, asked)
  if (questions.kind === "refused") return questions
  const given = nullable(record.value, "answer", at, answer)
  if (given.kind === "refused") return given
  return ok({ reason: reason.value, until: until.value, at: when.value, questions: questions.value, answer: given.value })
}

const hold: Guard<TaskHold> = (value, at) => {
  const current = holdRecord(value, at)
  if (current.kind === "refused") return current
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const history = record.value["history"] === undefined ? ok([]) : arrayOf(record.value, "history", at, holdRecord)
  return history.kind === "refused" ? history : ok({ ...current.value, history: history.value })
}

const parked: Guard<TaskParked> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const branch = string(record.value, "branch", at)
  if (branch.kind === "refused") return branch
  const questions = arrayOf(record.value, "questions", at, asked)
  return questions.kind === "refused" ? questions : ok({ branch: branch.value, questions: questions.value })
}

const account = (record: Fields, at: string): Guarded<string | null> => {
  if (record["claim"] === null || record["claim"] === undefined) return ok(null)
  const claim = fields(record["claim"], child(at, "claim"))
  return claim.kind === "refused" ? claim : string(claim.value, "account", child(at, "claim"))
}

const startedAt = (record: Fields, at: string): Guarded<string | null> => {
  if (record["started"] === null) return ok(null)
  const started = fields(record["started"], child(at, "started"))
  return started.kind === "refused" ? started : string(started.value, "at", child(at, "started"))
}

const closedState = (record: Fields, at: string, claimed: string | null): Guarded<TaskState> => {
  const started = startedAt(record, at)
  if (started.kind === "refused") return started
  const outcome = string(record, "outcome", at)
  if (outcome.kind === "refused") return outcome
  const pr = nullableString(record, "pr", at)
  if (pr.kind === "refused") return pr
  const report = nullableString(record, "report", at)
  if (report.kind === "refused") return report
  const given = absentOr(record, "answer", at, (entry, where) => entry === null ? ok(null) : answer(entry, where))
  if (given.kind === "refused") return given
  const closedAt = string(record, "closedAt", at)
  if (closedAt.kind === "refused") return closedAt
  return ok({ status: "closed", account: claimed, started: started.value, outcome: outcome.value, pr: pr.value, report: report.value, answer: given.value, closedAt: closedAt.value })
}

const taskState = (record: Fields, at: string): Guarded<TaskState> => {
  const status = oneOf(record, "status", at, ["new", "taken", "started", "closed"] as const)
  if (status.kind === "refused") return status
  if (status.value === "new") return ok({ status: "new" })
  const claimed = account(record, at)
  if (claimed.kind === "refused") return claimed
  if (status.value === "taken") return ok({ status: "taken", account: claimed.value })
  if (status.value === "closed") return closedState(record, at, claimed.value)
  const started = startedAt(record, at)
  if (started.kind === "refused") return started
  if (claimed.value === null || started.value === null) return refused(child(at, "claim"), "a claim and a start", record["claim"])
  return ok({ status: "started", account: claimed.value, started: started.value })
}

const priority = (record: Fields, at: string): Guarded<number | null> =>
  record["priority"] === null ? ok(null) : number(record, "priority", at)

const head = (record: Fields, at: string): Guarded<Pick<TaskDetail, "id" | "title" | "kind" | "body" | "created">> => {
  const id = string(record, "id", at)
  if (id.kind === "refused") return id
  const title = string(record, "title", at)
  if (title.kind === "refused") return title
  const kind = oneOf(record, "kind", at, boardKinds)
  if (kind.kind === "refused") return kind
  const body = string(record, "body", at)
  if (body.kind === "refused") return body
  const created = string(record, "created", at)
  return created.kind === "refused" ? created : ok({ id: id.value, title: title.value, kind: kind.value, body: body.value, created: created.value })
}

const taskDetail: Guard<TaskDetail> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const named = head(record.value, at)
  if (named.kind === "refused") return named
  const ranked = priority(record.value, at)
  if (ranked.kind === "refused") return ranked
  const dependsOn = arrayOf(record.value, "dependsOn", at, words)
  if (dependsOn.kind === "refused") return dependsOn
  const prState = record.value["prState"] === null ? ok(null) : oneOf(record.value, "prState", at, prStates)
  if (prState.kind === "refused") return prState
  const held = nullable(record.value, "hold", at, hold)
  if (held.kind === "refused") return held
  const waiting = nullable(record.value, "parked", at, parked)
  if (waiting.kind === "refused") return waiting
  const state = taskState(record.value, at)
  if (state.kind === "refused") return state
  return ok({ ...named.value, priority: ranked.value, dependsOn: dependsOn.value, prState: prState.value, hold: held.value, parked: waiting.value, state: state.value })
}

export const taskDetails: Guard<ReadonlyArray<TaskDetail>> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.backlog.v1")
  return schema.kind === "refused" ? schema : arrayOf(record.value, "tasks", at, taskDetail)
}

const taskRun: Guard<TaskRun | null> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  if (record.value["state"] === "queued") return ok(null)
  const id = string(record.value, "id", at)
  if (id.kind === "refused") return id
  const branch = string(record.value, "branch", at)
  if (branch.kind === "refused") return branch
  const machine = record.value["machine"] === undefined ? ok(null) : nullableString(record.value, "machine", at)
  return machine.kind === "refused" ? machine : ok({ id: id.value, branch: branch.value, machine: machine.value })
}

export const taskRuns: Guard<ReadonlyArray<TaskRun>> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.runs.v1")
  if (schema.kind === "refused") return schema
  const listed = arrayOf(record.value, "runs", at, taskRun)
  return listed.kind === "refused" ? listed : ok(listed.value.filter((entry) => entry !== null))
}
