import { Schema } from "effect"
import { DecisionAnswer, deciderLabel } from "../../shared/lib/index"
import { HoldJson, ParkedJson } from "./chat-parked"
import { taskKinds } from "../../entities/backlog/index"

export const ClosedTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(taskKinds),
  status: Schema.Literal("closed"),
  hold: Schema.NullOr(HoldJson),
  parked: Schema.NullOr(ParkedJson),
  outcome: Schema.Literals(["done", "failed", "stopped", "start-failed", "dropped"]),
  reason: Schema.String,
  landedIn: Schema.optional(Schema.String),
  pr: Schema.NullOr(Schema.String),
  report: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(DecisionAnswer),
  postedAt: Schema.NullOr(Schema.String)
})
export type ClosedTask = typeof ClosedTask.Type

const deliveredPart = (task: ClosedTask): string => {
  if (task.outcome === "dropped" || task.landedIn !== undefined) {
    return ""
  }
  if (task.kind === "decision") {
    return task.answer === null ? "" : " (" + deciderLabel(task.answer.decider) + "): " + task.answer.words
  }
  if (task.kind !== "ship") {
    return task.report === null ? ", with no report" : ", report " + task.report
  }
  return task.pr === null ? ", with no PR" : ""
}

const prPart = (task: ClosedTask): string => task.pr === null ? "" : ", PR " + task.pr

export const closedLine = (task: ClosedTask): string =>
  task.id + " " + task.title + " closed " + task.outcome + (task.reason === "" ? "" : ": " + task.reason) + deliveredPart(task) + prPart(task)
