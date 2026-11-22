import { laneFor } from "../../packages/herdr-app/src/board"
import { type Guard, type Guarded, arrayOf, child, fields, nullableString, ok, oneOf, string } from "../../packages/herdr-app/src/guard"
import type { TaskDetail } from "../../packages/herdr-app/src/task"
import { taskDetails } from "../../packages/herdr-app/src/task-guard"

export type Actor = "owner" | "orc" | "ci"

type NextAction =
  | { readonly waits: "priority"; readonly actor: "owner" }
  | { readonly waits: "decision"; readonly actor: "owner" }
  | { readonly waits: "hold"; readonly actor: "owner" }
  | { readonly waits: "answer"; readonly actor: "owner"; readonly questions: ReadonlyArray<string> }
  | { readonly waits: "ci"; readonly actor: "ci" }
  | { readonly waits: "dependency"; readonly actor: "orc" }
  | { readonly waits: "room"; readonly actor: "orc" }
  | { readonly waits: "run"; readonly actor: "orc" }
  | { readonly waits: "pull-request"; readonly actor: "owner" }
  | { readonly waits: "failed-run"; readonly actor: "owner" }
  | { readonly waits: "nothing" }

export interface TaskNext {
  readonly task: string
  readonly next: NextAction
  readonly detail: string | null
  readonly pr: string | null
}

const waitingKinds = ["no-priority", "decision", "held", "parked", "depends", "room"] as const

interface Waiting {
  readonly kind: typeof waitingKinds[number]
  readonly detail: string | null
}

interface Unread {
  readonly waiting: Waiting | null
  readonly sentPr: string | null
}

const ciWaitingQuestion = "ci-waiting"
const prUrl = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/

const waiting = (value: unknown, at: string): Guarded<Waiting | null> => {
  if (value === null) return ok(null)
  const wait = fields(value, at)
  if (wait.kind === "refused") return wait
  const kind = oneOf(wait.value, "kind", at, waitingKinds)
  if (kind.kind === "refused") return kind
  const detail = nullableString(wait.value, "detail", at)
  return detail.kind === "refused" ? detail : ok({ kind: kind.value, detail: detail.value })
}

const sentPr = (value: unknown, at: string): Guarded<string | null> => {
  if (value === null) return ok(null)
  const parked = fields(value, at)
  if (parked.kind === "refused") return parked
  if (parked.value["origin"] === undefined) return ok(null)
  const origin = fields(parked.value["origin"], child(at, "origin"))
  if (origin.kind === "refused") return origin
  return origin.value["pr"] === undefined ? ok(null) : string(origin.value, "pr", child(at, "origin"))
}

const unread: Guard<Unread> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const wait = waiting(record.value["waiting"], child(at, "waiting"))
  if (wait.kind === "refused") return wait
  const pr = sentPr(record.value["parked"], child(at, "parked"))
  return pr.kind === "refused" ? pr : ok({ waiting: wait.value, sentPr: pr.value })
}

const openQuestions = (task: TaskDetail): ReadonlyArray<string> =>
  task.parked?.questions.filter((question) => question.answer === null).map((question) => question.id) ?? []

// The Board JSON names the PR of a run that waits on CI only inside the text of its ci-waiting question.
const prOf = (task: TaskDetail, sent: string | null): string | null => {
  if (task.state.status === "closed") return task.state.pr
  const asked = task.parked?.questions.find((question) => question.id === ciWaitingQuestion && question.answer === null)
  return asked?.text.match(prUrl)?.[0] ?? sent
}

const newNext = (task: TaskDetail, wait: Waiting): NextAction => {
  switch (wait.kind) {
    case "no-priority": return { waits: "priority", actor: "owner" }
    case "decision": return { waits: "decision", actor: "owner" }
    case "held": return { waits: "hold", actor: "owner" }
    case "parked": {
      const questions = openQuestions(task)
      return questions.length === 1 && questions[0] === ciWaitingQuestion ? { waits: "ci", actor: "ci" } : { waits: "answer", actor: "owner", questions }
    }
    case "depends": return { waits: "dependency", actor: "orc" }
    case "room": return { waits: "room", actor: "orc" }
  }
}

const laterNext = (task: TaskDetail): NextAction => {
  const lane = laneFor({ ...task, project: "", status: task.state.status, held: false, parked: false }, new Set())
  if (lane === "Running") return { waits: "run", actor: "orc" }
  if (lane === "Awaiting you") return { waits: "pull-request", actor: "owner" }
  const failed = task.state.status === "closed" && (task.state.outcome === "failed" || task.state.outcome === "start-failed")
  return failed ? { waits: "failed-run", actor: "owner" } : { waits: "nothing" }
}

const taskNext = (task: TaskDetail, { waiting, sentPr }: Unread): TaskNext => ({
  task: task.id,
  next: task.state.status === "new" && waiting !== null ? newNext(task, waiting) : laterNext(task),
  detail: waiting?.detail ?? null,
  pr: prOf(task, sentPr)
})

export const boardNext: Guard<ReadonlyArray<TaskNext>> = (value, at) => {
  const tasks = taskDetails(value, at)
  if (tasks.kind === "refused") return tasks
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const extras = arrayOf(record.value, "tasks", at, unread)
  if (extras.kind === "refused") return extras
  return ok(tasks.value.map((task, index) => taskNext(task, extras.value[index] ?? { waiting: null, sentPr: null })))
}
