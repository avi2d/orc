import { Schema } from "effect"
import { HoldJson, ParkedJson } from "./chat-parked"
import { taskKinds } from "./task-kind"

export const ClosedTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(taskKinds),
  status: Schema.Literal("closed"),
  hold: Schema.NullOr(HoldJson),
  parked: Schema.NullOr(ParkedJson),
  outcome: Schema.Literals(["done", "failed", "start-failed"]),
  reason: Schema.String,
  pr: Schema.NullOr(Schema.String),
  report: Schema.NullOr(Schema.String),
  postedAt: Schema.NullOr(Schema.String)
})
export type ClosedTask = typeof ClosedTask.Type

const deliveredPart = (task: ClosedTask): string => {
  if (task.kind !== "ship") {
    return task.report === null ? ", with no report" : ", report " + task.report
  }
  return task.pr === null ? ", with no PR" : ", PR " + task.pr
}

export const closedLine = (task: ClosedTask): string =>
  task.id + " " + task.title + " closed " + task.outcome + (task.reason === "" ? "" : ": " + task.reason) + deliveredPart(task)
