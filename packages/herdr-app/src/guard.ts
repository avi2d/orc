import type { BoardTask } from "./board"

export type Guarded<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "refused"; readonly reason: string }

export type Guard<A> = (value: unknown, at: string) => Guarded<A>

type Fields = Readonly<Record<string, unknown>>

export const ok = <A>(value: A): Guarded<A> => ({ kind: "ok", value })

const refused = (at: string, wanted: string, value: unknown): Guarded<never> => {
  const where = at === "" ? "the document" : at
  return {
    kind: "refused",
    reason: value === undefined ? `${where} is missing` : `${where} is ${JSON.stringify(value)}, not ${wanted}`
  }
}

export const child = (at: string, name: string): string => at === "" ? name : `${at}.${name}`

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const fields: Guard<Fields> = (value, at) => isFields(value) ? ok(value) : refused(at, "an object", value)

export const string = (record: Fields, name: string, at: string): Guarded<string> => {
  const value = record[name]
  return typeof value === "string" ? ok(value) : refused(child(at, name), "a string", value)
}

export const number = (record: Fields, name: string, at: string): Guarded<number> => {
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

export const literal = <L extends string | number>(record: Fields, name: string, at: string, wanted: L): Guarded<L> =>
  record[name] === wanted ? ok(wanted) : refused(child(at, name), JSON.stringify(wanted), record[name])

export const arrayOf = <A>(record: Fields, name: string, at: string, item: Guard<A>): Guarded<ReadonlyArray<A>> => {
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
  if (name === "hold" && holder.value["answer"] !== null && holder.value["answer"] !== undefined) return ok(null)
  const questions = arrayOf(holder.value, "questions", child(at, name), question)
  if (questions.kind === "refused") return questions
  const raw = holder.value["questions"]
  const open = Array.isArray(raw) ? raw.filter((entry) => !isFields(entry) || entry["answer"] === null || entry["answer"] === undefined).length : questions.value.length
  return ok(open)
}

const namedProject = (record: Fields, at: string): Guarded<{ id: string; title: string; project: string }> => {
  const named = pair(record, at, "id", "title", (id, title) => ({ id, title }))
  if (named.kind === "refused") return named
  const project = string(record, "project", at)
  if (project.kind === "refused") return project
  return ok({ ...named.value, project: project.value })
}

const taskHead = <K, S>(record: Fields, at: string, readKind: (record: Fields, at: string) => Guarded<K>, readStatus: (record: Fields, at: string) => Guarded<S>): Guarded<{ id: string; title: string; project: string; kind: K; status: S }> => {
  const head = namedProject(record, at)
  if (head.kind === "refused") return head
  const kind = readKind(record, at)
  if (kind.kind === "refused") return kind
  const status = readStatus(record, at)
  if (status.kind === "refused") return status
  return ok({ ...head.value, kind: kind.value, status: status.value })
}

const schemaTasks = <A>(record: Fields, at: string, item: Guard<A>): Guarded<{ schema: "orc.backlog.v1"; tasks: ReadonlyArray<A> }> => {
  const schema = literal(record, "schema", at, "orc.backlog.v1")
  if (schema.kind === "refused") return schema
  const tasks = arrayOf(record, "tasks", at, item)
  if (tasks.kind === "refused") return tasks
  return ok({ schema: schema.value, tasks: tasks.value })
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
}

const task: Guard<Task> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const head = taskHead(record.value, at, (r, a) => string(r, "kind", a), (r, a) => string(r, "status", a))
  if (head.kind === "refused") return head
  const hold = questionCount(record.value, "hold", at)
  if (hold.kind === "refused") return hold
  const parked = questionCount(record.value, "parked", at)
  if (parked.kind === "refused") return parked
  const reason = absentOrString(record.value, "reason", at)
  if (reason.kind === "refused") return reason
  return ok({ ...head.value, hold: hold.value, parked: parked.value, reason: reason.value })
}

export interface Backlog {
  readonly schema: "orc.backlog.v1"
  readonly tasks: ReadonlyArray<Task>
  readonly merged: ReadonlyArray<string>
}

export const backlog: Guard<Backlog> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const head = schemaTasks(record.value, at, task)
  if (head.kind === "refused") return head
  const mergedRaw = record.value["merged"]
  if (mergedRaw === undefined) return ok({ schema: head.value.schema, tasks: head.value.tasks, merged: [] })
  if (!Array.isArray(mergedRaw)) return refused(child(at, "merged"), "an array", mergedRaw)
  const merged: Array<string> = []
  for (const [index, entry] of mergedRaw.entries()) {
    if (typeof entry !== "string") return refused(child(at, "merged") + "[" + index.toString() + "]", "a string", entry)
    merged.push(entry)
  }
  return ok({ schema: head.value.schema, tasks: head.value.tasks, merged })
}

const boardKinds = ["ship", "scout", "task", "decision", "parent"] as const
const boardStatuses = ["new", "taken", "started", "closed"] as const
const prStates = ["open", "closed", "merged"] as const

const answerPresent = (value: unknown, at: string): Guarded<boolean> => {
  if (value === null) return ok(false)
  const answer = fields(value, at)
  if (answer.kind === "refused") return answer
  const words = string(answer.value, "words", at)
  if (words.kind === "refused") return words
  const time = string(answer.value, "at", at)
  if (time.kind === "refused") return time
  return ok(true)
}

const boardQuestion: Guard<boolean> = (value, at) => {
  const asked = fields(value, at)
  if (asked.kind === "refused") return asked
  return answerPresent(asked.value["answer"], child(at, "answer"))
}

const boardHold = (value: unknown, at: string): Guarded<boolean> => {
  if (value === null) return ok(false)
  const hold = fields(value, at)
  if (hold.kind === "refused") return hold
  const answer = answerPresent(hold.value["answer"], child(at, "answer"))
  return answer.kind === "refused" ? answer : ok(!answer.value)
}

const boardParked = (value: unknown, at: string): Guarded<boolean> => {
  if (value === null) return ok(false)
  const parked = fields(value, at)
  if (parked.kind === "refused") return parked
  const questions = arrayOf(parked.value, "questions", at, boardQuestion)
  return questions.kind === "refused" ? questions : ok(questions.value.some((answered) => !answered))
}

const boardTask: Guard<BoardTask> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const head = taskHead(record.value, at, (r, a) => oneOf(r, "kind", a, boardKinds), (r, a) => oneOf(r, "status", a, boardStatuses))
  if (head.kind === "refused") return head
  const created = string(record.value, "created", at)
  if (created.kind === "refused") return created
  const held = boardHold(record.value["hold"], child(at, "hold"))
  if (held.kind === "refused") return held
  const parked = boardParked(record.value["parked"], child(at, "parked"))
  if (parked.kind === "refused") return parked
  const prState = record.value["prState"] === null ? ok(null) : oneOf(record.value, "prState", at, prStates)
  if (prState.kind === "refused") return prState
  return ok({ ...head.value, created: created.value, held: held.value, parked: parked.value, prState: prState.value })
}

const boardProject: Guard<string> = (value, at) => {
  const project = fields(value, at)
  return project.kind === "refused" ? project : string(project.value, "name", at)
}

export interface BoardBacklog {
  readonly tasks: ReadonlyArray<BoardTask>
  readonly projects: ReadonlyArray<string> | null
}

export const boardBacklog: Guard<BoardBacklog> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const head = schemaTasks(record.value, at, boardTask)
  if (head.kind === "refused") return head
  const projects = record.value["projects"] === null ? ok(null) : arrayOf(record.value, "projects", at, boardProject)
  if (projects.kind === "refused") return projects
  return ok({ tasks: head.value.tasks, projects: projects.value })
}

interface BoardAttentionItem {
  readonly task: string
  readonly owner: "user" | "decider"
}

const boardAttentionItem: Guard<BoardAttentionItem> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const taskId = string(record.value, "task", at)
  if (taskId.kind === "refused") return taskId
  const owner = oneOf(record.value, "owner", at, ["user", "decider"] as const)
  return owner.kind === "refused" ? owner : ok({ task: taskId.value, owner: owner.value })
}

export interface BoardAttention {
  readonly items: ReadonlyArray<BoardAttentionItem>
}

export const boardAttention: Guard<BoardAttention> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schema = literal(record.value, "schema", at, "orc.attention.v1")
  if (schema.kind === "refused") return schema
  const items = arrayOf(record.value, "items", at, boardAttentionItem)
  return items.kind === "refused" ? items : ok({ items: items.value })
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
  readonly kind: string | null
  readonly delivery: string | null
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
  const kind = record.value["kind"] === undefined ? ok(null) : nullableString(record.value, "kind", at)
  if (kind.kind === "refused") return kind
  const delivery = record.value["delivery"] === undefined ? ok(null) : nullableString(record.value, "delivery", at)
  if (delivery.kind === "refused") return delivery
  return ok({ ...placed.value, branch: branch.value, status: status.value, prLink: prLink.value, title: title.value, step: latest.value, questions: questions.value, endReason: endReason.value, kind: kind.value, delivery: delivery.value })
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

