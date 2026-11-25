import type { BoardTask, QueuedRun } from "./board"
import { type Guard, arrayOf, boardKinds, fields, nullableString, number, ok, oneOf, prStates, projectName, runsHead, schemaTasks, string, taskHead } from "./guard"

const boardStatuses = ["new", "taken", "started", "closed"] as const

const boardTask: Guard<BoardTask> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const head = taskHead(record.value, at, (r, a) => oneOf(r, "kind", a, boardKinds), (r, a) => oneOf(r, "status", a, boardStatuses))
  if (head.kind === "refused") return head
  const created = string(record.value, "created", at)
  if (created.kind === "refused") return created
  const prState = record.value["prState"] === null ? ok(null) : oneOf(record.value, "prState", at, prStates)
  if (prState.kind === "refused") return prState
  return ok({ ...head.value, created: created.value, prState: prState.value })
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
  const projects = record.value["projects"] === null ? ok(null) : arrayOf(record.value, "projects", at, projectName)
  if (projects.kind === "refused") return projects
  return ok({ tasks: head.value.tasks, projects: projects.value })
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
