import type { BoardTask, QueuedRun } from "./board"
import { type Guard, type Guarded, arrayOf, boardKinds, child, fields, literal, nullableString, number, ok, oneOf, prStates, runsHead, schemaTasks, string, taskHead } from "./guard"

const boardStatuses = ["new", "taken", "started", "closed"] as const

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

const queuedEntry: Guard<QueuedRun | null> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  if (record.value["state"] !== "queued") return ok(null)
  const task = string(record.value, "task", at)
  if (task.kind === "refused") return task
  const machine = record.value["machine"] === undefined ? ok(null) : nullableString(record.value, "machine", at)
  if (machine.kind === "refused") return machine
  const ahead = record.value["ahead"] === undefined ? ok(null) : number(record.value, "ahead", at)
  return ahead.kind === "refused" ? ahead : ok({ task: task.value, machine: machine.value, ahead: ahead.value })
}

export const boardQueue: Guard<ReadonlyArray<QueuedRun>> = (value, at) => {
  const document = runsHead(value, at)
  if (document.kind === "refused") return document
  const listed = arrayOf(document.value.record, "runs", at, queuedEntry)
  return listed.kind === "refused" ? listed : ok(listed.value.filter((entry) => entry !== null))
}
