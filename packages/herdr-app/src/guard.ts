export type Guarded<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "refused"; readonly reason: string }

export type Guard<A> = (value: unknown, at: string) => Guarded<A>

type Fields = Readonly<Record<string, unknown>>

const ok = <A>(value: A): Guarded<A> => ({ kind: "ok", value })

const refused = (at: string, wanted: string, value: unknown): Guarded<never> => {
  const where = at === "" ? "the document" : at
  return {
    kind: "refused",
    reason: value === undefined ? `${where} is missing` : `${where} is ${JSON.stringify(value)}, not ${wanted}`
  }
}

const child = (at: string, name: string): string => at === "" ? name : `${at}.${name}`

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fields: Guard<Fields> = (value, at) => isFields(value) ? ok(value) : refused(at, "an object", value)

const string = (record: Fields, name: string, at: string): Guarded<string> => {
  const value = record[name]
  return typeof value === "string" ? ok(value) : refused(child(at, name), "a string", value)
}

const number = (record: Fields, name: string, at: string): Guarded<number> => {
  const value = record[name]
  return typeof value === "number" && Number.isFinite(value) ? ok(value) : refused(child(at, name), "a number", value)
}

const nullableString = (record: Fields, name: string, at: string): Guarded<string | null> =>
  record[name] === null ? ok(null) : string(record, name, at)

const absentOrString = (record: Fields, name: string, at: string): Guarded<string | null> =>
  record[name] === undefined ? ok(null) : nullableString(record, name, at)

const oneOf = <L extends string>(record: Fields, name: string, at: string, wanted: ReadonlyArray<L>): Guarded<L> => {
  const value = record[name]
  const found = wanted.find((entry) => entry === value)
  return found === undefined ? refused(child(at, name), wanted.map((entry) => JSON.stringify(entry)).join(" or "), value) : ok(found)
}

const literal = <L extends string | number>(record: Fields, name: string, at: string, wanted: L): Guarded<L> =>
  record[name] === wanted ? ok(wanted) : refused(child(at, name), JSON.stringify(wanted), record[name])

const arrayOf = <A>(record: Fields, name: string, at: string, item: Guard<A>): Guarded<ReadonlyArray<A>> => {
  const value = record[name]
  if (!Array.isArray(value)) {
    return refused(child(at, name), "an array", value)
  }
  const items: Array<A> = []
  for (const [index, entry] of value.entries()) {
    const guarded = item(entry, `${child(at, name)}[${index}]`)
    if (guarded.kind === "refused") {
      return guarded
    }
    items.push(guarded.value)
  }
  return ok(items)
}

export const guardJson = <A>(text: string, guard: Guard<A>): Guarded<A> => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: "refused", reason: "the output is no JSON" }
  }
  return guard(value, "")
}

const pair = <A>(record: Fields, at: string, first: string, second: string, make: (a: string, b: string) => A): Guarded<A> => {
  const a = string(record, first, at)
  if (a.kind === "refused") return a
  const b = string(record, second, at)
  if (b.kind === "refused") return b
  return ok(make(a.value, b.value))
}

const question: Guard<string> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  return string(record.value, "id", at)
}

const questionCount = (record: Fields, name: string, at: string): Guarded<number | null> => {
  if (record[name] === null) return ok(null)
  const holder = fields(record[name], child(at, name))
  if (holder.kind === "refused") return holder
  const questions = arrayOf(holder.value, "questions", child(at, name), question)
  if (questions.kind === "refused") return questions
  return ok(questions.value.length)
}

export interface Task {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly kind: string
  readonly status: string
  readonly hold: number | null
  readonly parked: number | null
  readonly reason: string | null
  readonly pr: string | null
}

const task: Guard<Task> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const named = pair(record.value, at, "id", "title", (id, title) => ({ id, title }))
  if (named.kind === "refused") return named
  const project = string(record.value, "project", at)
  if (project.kind === "refused") return project
  const kind = string(record.value, "kind", at)
  if (kind.kind === "refused") return kind
  const status = string(record.value, "status", at)
  if (status.kind === "refused") return status
  const hold = questionCount(record.value, "hold", at)
  if (hold.kind === "refused") return hold
  const parked = questionCount(record.value, "parked", at)
  if (parked.kind === "refused") return parked
  const reason = absentOrString(record.value, "reason", at)
  if (reason.kind === "refused") return reason
  const pr = absentOrString(record.value, "pr", at)
  if (pr.kind === "refused") return pr
  return ok({ ...named.value, project: project.value, kind: kind.value, status: status.value, hold: hold.value, parked: parked.value, reason: reason.value, pr: pr.value })
}

const eventKey: Guard<string> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  return string(record.value, "key", at)
}

export interface Backlog {
  readonly schema: "orc.backlog.v1"
  readonly tasks: ReadonlyArray<Task>
  readonly events: ReadonlyArray<string>
}

export const backlog: Guard<Backlog> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.backlog.v1")
  if (schema.kind === "refused") return schema
  const tasks = arrayOf(record.value, "tasks", at, task)
  if (tasks.kind === "refused") return tasks
  const events = arrayOf(record.value, "events", at, eventKey)
  if (events.kind === "refused") return events
  return ok({ schema: schema.value, tasks: tasks.value, events: events.value })
}

const stepStatuses = ["running", "passed", "failed", "skipped"] as const

export interface Step {
  readonly id: number
  readonly name: string
  readonly attempt: number
  readonly status: typeof stepStatuses[number]
}

const step: Guard<Step> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const id = number(record.value, "id", at)
  if (id.kind === "refused") return id
  const name = string(record.value, "name", at)
  if (name.kind === "refused") return name
  const attempt = number(record.value, "attempt", at)
  if (attempt.kind === "refused") return attempt
  const status = oneOf(record.value, "status", at, stepStatuses)
  if (status.kind === "refused") return status
  return ok({ id: id.value, name: name.value, attempt: attempt.value, status: status.value })
}

const runStatuses = ["running", "succeeded", "failed", "stopped"] as const

export interface Run {
  readonly id: string
  readonly project: string
  readonly branch: string
  readonly status: typeof runStatuses[number]
  readonly prLink: string | null
  readonly title: string | null
  readonly step: Step | null
  readonly questions: number
  readonly endReason: string | null
}

const run: Guard<Run> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const placed = pair(record.value, at, "id", "project", (id, project) => ({ id, project }))
  if (placed.kind === "refused") return placed
  const branch = string(record.value, "branch", at)
  if (branch.kind === "refused") return branch
  const status = oneOf(record.value, "status", at, runStatuses)
  if (status.kind === "refused") return status
  const prLink = nullableString(record.value, "prLink", at)
  if (prLink.kind === "refused") return prLink
  const title = nullableString(record.value, "title", at)
  if (title.kind === "refused") return title
  const latest = record.value["step"] === null ? ok(null) : step(record.value["step"], child(at, "step"))
  if (latest.kind === "refused") return latest
  const questions = number(record.value, "questions", at)
  if (questions.kind === "refused") return questions
  const endReason = nullableString(record.value, "endReason", at)
  if (endReason.kind === "refused") return endReason
  return ok({ ...placed.value, branch: branch.value, status: status.value, prLink: prLink.value, title: title.value, step: latest.value, questions: questions.value, endReason: endReason.value })
}

export interface Runs {
  readonly schema: "orc.runs.v1"
  readonly runs: ReadonlyArray<Run>
}

export interface Show {
  readonly schema: "orc.show.v1"
  readonly steps: ReadonlyArray<Step>
}

export const show: Guard<Show> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.show.v1")
  if (schema.kind === "refused") return schema
  const steps = arrayOf(record.value, "steps", at, step)
  if (steps.kind === "refused") return steps
  return ok({ schema: schema.value, steps: steps.value })
}

export const runs: Guard<Runs> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.runs.v1")
  if (schema.kind === "refused") return schema
  const list = arrayOf(record.value, "runs", at, run)
  if (list.kind === "refused") return list
  return ok({ schema: schema.value, runs: list.value })
}

interface Account {
  readonly title: string
}

const account: Guard<Account> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const title = string(record.value, "title", at)
  if (title.kind === "refused") return title
  return ok({ title: title.value })
}

type Quota =
  | { readonly status: "ok"; readonly accounts: ReadonlyArray<Account> }
  | { readonly status: "failed"; readonly error: string }

const quota: Guard<Quota> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  if (record.value["status"] === "failed") {
    const error = string(record.value, "error", at)
    if (error.kind === "refused") return error
    return ok({ status: "failed", error: error.value })
  }
  const status = literal(record.value, "status", at, "ok")
  if (status.kind === "refused") return status
  const report = fields(record.value["report"], child(at, "report"))
  if (report.kind === "refused") return report
  const accounts = arrayOf(report.value, "accounts", child(at, "report"), account)
  if (accounts.kind === "refused") return accounts
  return ok({ status: "ok", accounts: accounts.value })
}

export interface QuotaSnapshot {
  readonly schemaVersion: 1
  readonly quota: Quota
}

export const quotaSnapshot: Guard<QuotaSnapshot> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schemaVersion = literal(record.value, "schemaVersion", at, 1)
  if (schemaVersion.kind === "refused") return schemaVersion
  const sources = fields(record.value["sources"], child(at, "sources"))
  if (sources.kind === "refused") return sources
  const answer = quota(sources.value["quota"], child(child(at, "sources"), "quota"))
  if (answer.kind === "refused") return answer
  return ok({ schemaVersion: schemaVersion.value, quota: answer.value })
}
