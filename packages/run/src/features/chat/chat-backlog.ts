import { Schema } from "effect"
import { ClosedTask } from "./chat-closed"
import { HoldJson, ParkedJson, QuestionJson } from "./chat-parked"

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
  readonly generation: number
}

export const parkedReason = (branch: string): string => "Parked on " + branch + " for the captain's answers."

export const decisionFor = (task: BacklogTask, waits: "held" | "parked"): Decision | null => {
  if (waits === "parked") {
    return task.status !== "closed" && task.parked !== null && task.parked.questions.some((question) => question.answer === null)
      ? { id: task.id, title: task.title, waits: "parked", reason: parkedReason(task.parked.branch), questions: task.parked.questions, generation: 0 }
      : null
  }
  return isOpenHeld(task) ? { id: task.id, title: task.title, waits: "held", reason: task.hold.reason, questions: task.hold.questions, generation: task.hold.history?.length ?? 0 } : null
}

// Parked comes first because orc backlog answer answers a parked question before a hold.
export const openDecision = (task: BacklogTask): Decision | null => decisionFor(task, "parked") ?? decisionFor(task, "held")

const BacklogEvent = Schema.Struct({ key: Schema.String, text: Schema.String })

export const BacklogTasks = Schema.fromJsonString(Schema.Struct({ tasks: Schema.Array(Schema.Union([ClosedTask, OpenTask])), events: Schema.Array(BacklogEvent) }))
