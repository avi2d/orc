import { Schema } from "effect"
import { ClosedTask } from "./chat-closed"
import { ParkedJson, QuestionJson } from "./chat-parked"

const HoldJson = Schema.Struct({
  reason: Schema.String,
  until: Schema.NullOr(Schema.String),
  questions: Schema.Array(QuestionJson),
  answer: Schema.NullOr(Schema.Struct({ words: Schema.String, at: Schema.String }))
})
type HoldJson = typeof HoldJson.Type

const OpenTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["new", "taken", "started"]),
  hold: Schema.NullOr(HoldJson),
  parked: Schema.NullOr(ParkedJson)
})
type OpenTask = typeof OpenTask.Type
export type BacklogTask = ClosedTask | OpenTask

export type OpenHeld = OpenTask & { readonly hold: HoldJson & { readonly answer: null } }

export const isOpenHeld = (task: BacklogTask): task is OpenHeld => task.status !== "closed" && task.hold !== null && task.hold.answer === null

type Question = typeof QuestionJson.Type

export interface Decision {
  readonly id: string
  readonly title: string
  readonly waits: "held" | "parked"
  readonly reason: string
  readonly questions: ReadonlyArray<Question>
}

// Parked comes first because orc backlog answer answers a parked question before a hold.
export const openDecision = (task: BacklogTask): Decision | null => {
  if (task.status !== "closed" && task.parked !== null && task.parked.questions.some((question) => question.answer === null)) {
    return { id: task.id, title: task.title, waits: "parked", reason: "Parked on " + task.parked.branch + " for the captain's answers.", questions: task.parked.questions }
  }
  return isOpenHeld(task) ? { id: task.id, title: task.title, waits: "held", reason: task.hold.reason, questions: task.hold.questions } : null
}

export const BacklogTasks = Schema.fromJsonString(Schema.Struct({ tasks: Schema.Array(Schema.Union([ClosedTask, OpenTask])) }))
