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

interface Task {
  readonly id: string
  readonly title: string
}

const task: Guard<Task> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const id = string(record.value, "id", at)
  if (id.kind === "refused") return id
  const title = string(record.value, "title", at)
  if (title.kind === "refused") return title
  return ok({ id: id.value, title: title.value })
}

export interface Backlog {
  readonly schema: "orc.backlog.v1"
  readonly tasks: ReadonlyArray<Task>
}

export const backlog: Guard<Backlog> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.backlog.v1")
  if (schema.kind === "refused") return schema
  const tasks = arrayOf(record.value, "tasks", at, task)
  if (tasks.kind === "refused") return tasks
  return ok({ schema: schema.value, tasks: tasks.value })
}

interface Run {
  readonly id: string
  readonly status: string
}

const run: Guard<Run> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const id = string(record.value, "id", at)
  if (id.kind === "refused") return id
  const status = string(record.value, "status", at)
  if (status.kind === "refused") return status
  return ok({ id: id.value, status: status.value })
}

export interface Runs {
  readonly schema: "orc.runs.v1"
  readonly runs: ReadonlyArray<Run>
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
