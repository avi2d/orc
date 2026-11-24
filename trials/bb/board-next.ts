import { laneFor } from "../../packages/herdr-app/src/board"
import { type Guard, type Guarded, arrayOf, child, fields, ok, oneOf, refused, string } from "../../packages/herdr-app/src/guard"
import type { TaskDetail } from "../../packages/herdr-app/src/task"
import { taskDetails } from "../../packages/herdr-app/src/task-guard"

export type Actor = "owner" | "orc" | "ci"

type NextAction =
  | { readonly waits: "priority"; readonly actor: "owner" }
  | { readonly waits: "decision"; readonly actor: "owner" }
  | { readonly waits: "hold"; readonly actor: "owner" }
  | { readonly waits: "answer"; readonly actor: "owner" | "orc"; readonly questions: ReadonlyArray<string> }
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
  readonly pr: string | null
}

const waitingKinds = ["no-priority", "decision", "held", "parked", "depends", "room"] as const
type Waiting = typeof waitingKinds[number]

interface WaitQuestion {
  readonly id: string
  readonly deciderOwns: boolean
}

interface ParkedExtra {
  readonly sentPr: string | null
  readonly questions: ReadonlyArray<WaitQuestion>
}

interface Unread extends ParkedExtra {
  readonly waiting: Waiting | null
}

const ciWaitingQuestion = "ci-waiting"
const prUrl = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/
const fullPrPattern = new RegExp("^" + prUrl.source + "$")
const fullPrUrl = (value: string | null): string | null => value !== null && fullPrPattern.test(value) ? value : null

const waiting = (value: unknown, at: string): Guarded<Waiting | null> => {
  if (value === null) return ok(null)
  const wait = fields(value, at)
  return wait.kind === "refused" ? wait : oneOf(wait.value, "kind", at, waitingKinds)
}

const sentPr = (value: unknown, at: string): Guarded<string | null> => {
  if (value === undefined) return ok(null)
  const origin = fields(value, at)
  if (origin.kind === "refused") return origin
  if (origin.value["pr"] === undefined) return ok(null)
  const pr = string(origin.value, "pr", at)
  return pr.kind === "refused" ? pr : ok(fullPrUrl(pr.value))
}

const waitQuestion: Guard<WaitQuestion | null> = (value, at) => {
  const question = fields(value, at)
  if (question.kind === "refused") return question
  const id = string(question.value, "id", at)
  if (id.kind === "refused") return id
  const blocks = question.value["blocks"]
  if (typeof blocks !== "boolean") return refused(child(at, "blocks"), "a boolean", blocks)
  const deciderOwns = question.value["deciderOwns"]
  if (typeof deciderOwns !== "boolean") return refused(child(at, "deciderOwns"), "a boolean", deciderOwns)
  return ok(blocks && question.value["answer"] === null ? { id: id.value, deciderOwns } : null)
}

const parkedExtra: Guard<ParkedExtra> = (value, at) => {
  if (value === null) return ok({ sentPr: null, questions: [] })
  const parked = fields(value, at)
  if (parked.kind === "refused") return parked
  const pr = sentPr(parked.value["origin"], child(at, "origin"))
  if (pr.kind === "refused") return pr
  const questions = arrayOf(parked.value, "questions", at, waitQuestion)
  return questions.kind === "refused" ? questions : ok({ sentPr: pr.value, questions: questions.value.filter((question) => question !== null) })
}

const unread: Guard<Unread> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const wait = waiting(record.value["waiting"], child(at, "waiting"))
  if (wait.kind === "refused") return wait
  const parked = parkedExtra(record.value["parked"], child(at, "parked"))
  return parked.kind === "refused" ? parked : ok({ waiting: wait.value, ...parked.value })
}

const prOf = (task: TaskDetail, sent: string | null): string | null => {
  if (task.state.status === "closed") return fullPrUrl(task.state.pr)
  const asked = task.parked?.questions.find((question) => question.id === ciWaitingQuestion && question.answer === null)
  return asked?.text.match(prUrl)?.[0] ?? sent
}

const newNext = (wait: Waiting, questions: ReadonlyArray<WaitQuestion>): NextAction => {
  switch (wait) {
    case "no-priority": return { waits: "priority", actor: "owner" }
    case "decision": return { waits: "decision", actor: "owner" }
    case "held": return { waits: "hold", actor: "owner" }
    case "parked": {
      if (questions.length === 1 && questions[0].id === ciWaitingQuestion) return { waits: "ci", actor: "ci" }
      const answers = questions.filter((question) => question.id !== ciWaitingQuestion)
      const actor = answers.length > 0 && answers.every((question) => question.deciderOwns) ? "orc" : "owner"
      return { waits: "answer", actor, questions: questions.map((question) => question.id) }
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

const taskNext = (task: TaskDetail, extra: Unread): TaskNext => ({
  task: task.id,
  next: task.state.status === "new" && extra.waiting !== null ? newNext(extra.waiting, extra.questions) : laterNext(task),
  pr: prOf(task, extra.sentPr)
})

export const boardNext: Guard<ReadonlyArray<TaskNext>> = (value, at) => {
  const tasks = taskDetails(value, at)
  if (tasks.kind === "refused") return tasks
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const extras = arrayOf(record.value, "tasks", at, unread)
  if (extras.kind === "refused") return extras
  return ok(tasks.value.map((task, index) => taskNext(task, extras.value[index])))
}
