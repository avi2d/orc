import { Schema } from "effect"
import { mergeBases } from "./dispatch/merge-basis"
import { taskKinds } from "./task-kind"

export const AddTaskInput = Schema.Struct({
  project: Schema.String.annotate({ description: "The project the task is for, as the backlog's project list names it" }),
  task: Schema.String.annotate({ description: "The task as markdown, whose first line is its title" }),
  kind: Schema.optionalKey(Schema.Literals(taskKinds).annotate({
    description: "ship ends in a PR and is the default; scout and task end in a report file in the run folder instead"
  })),
  internal: Schema.optionalKey(Schema.Boolean.annotate({
    description: "Marks a ship task internal-only, so a no-mistakes-prod-only project opens its PR after checks without no-mistakes"
  })),
  machine: Schema.optionalKey(Schema.String.annotate({ description: "The one machine the task may run on" })),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "The ids of the tasks that must close done before this one starts" }))
})

export const HoldInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the new task that waits for the captain" }),
  reason: Schema.String.annotate({ description: "The decision the captain must make before the task may start" }),
  until: Schema.optionalKey(Schema.String.annotate({ description: "The YYYY-MM-DD date the captain should answer by; it releases nothing by itself" }))
})

export const AnswerInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the held or parked task" }),
  question: Schema.optionalKey(Schema.String.annotate({ description: "The id of the parked question the captain answers, such as question-4; leave it out for a held task" })),
  words: Schema.String.annotate({ description: "The captain's answer, word for word" })
})

export const MergeInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the closed task whose PR lands" }),
  basis: Schema.Literals(mergeBases).annotate({
    description: "captain-word when the captain explicitly said to merge this PR; yolo-green when the task's project has yolo true and the PR is green"
  })
})
