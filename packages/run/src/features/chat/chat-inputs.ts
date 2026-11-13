import { Schema } from "effect"
import { mergeBases } from "../../entities/pull-request/index"
import { taskKinds } from "../../entities/backlog/index"

export const AddTaskInput = Schema.Struct({
  project: Schema.String.annotate({ description: "The project the task is for, as the backlog's project list names it" }),
  task: Schema.String.annotate({ description: "The task as markdown, whose first line is its title" }),
  kind: Schema.optionalKey(Schema.Literals(taskKinds).annotate({
    description: "ship ends in a PR and is the default; scout and task end in a report file in the run folder instead; parent holds the done criteria and waits for its children"
  })),
  internal: Schema.optionalKey(Schema.Boolean.annotate({
    description: "Marks a ship task internal-only, so a no-mistakes-prod-only project opens its PR after checks without no-mistakes"
  })),
  machine: Schema.optionalKey(Schema.String.annotate({ description: "The one machine the task may run on" })),
  parent: Schema.optionalKey(Schema.String.annotate({ description: "The id of the parent task this task is a child of" })),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "The ids of the tasks that must close done before this one starts" }))
})

export const HoldInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the new task that waits for the captain" }),
  reason: Schema.String.annotate({ description: "The decision the captain must make before the task may start" }),
  until: Schema.optionalKey(Schema.String.annotate({ description: "The YYYY-MM-DD date the captain should answer by; it releases nothing by itself" })),
  questions: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isNonEmpty())).annotate({
    description: "The separate questions the captain answers one by one, ids question-1 onward; the task stays held until every one is answered"
  }))
})

export const EditInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the new task whose text changes" }),
  task: Schema.String.annotate({ description: "The task's whole new text as markdown, whose first line is its title" })
})

export const AnswerInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the held or parked task" }),
  question: Schema.optionalKey(Schema.String.annotate({
    description: "The id of the parked or held question the captain answers, such as question-4; leave it out for a task held with a reason and no questions"
  })),
  words: Schema.String.annotate({ description: "The captain's answer, word for word" })
})

const BoardCard = Schema.Struct({
  question: Schema.optionalKey(Schema.String.annotate({
    description: "The id of the held or parked question this card answers, such as question-2; leave it out when the task was held with a reason and no questions"
  })),
  options: Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty())).annotate({ description: "The options the captain picks one of, each recorded word for word when picked" }),
  recommended: Schema.String.annotate({ description: "The option you recommend, written exactly as it appears in options" })
})
export type BoardCard = typeof BoardCard.Type

export const BoardInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the held or parked task the board decides" }),
  cards: Schema.NonEmptyArray(BoardCard).annotate({ description: "One card per open question on the hold or park" })
})
export type BoardInput = typeof BoardInput.Type

export const MergeInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id of the closed task whose PR lands" }),
  basis: Schema.Literals(mergeBases).annotate({
    description: "captain-word when the captain explicitly said to merge this PR. yolo-green when asked to merge a yolo project's PR and the PR is green"
  })
})
