import { Effect, Schema } from "effect"

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
  readonly id: string
  readonly title: string
  readonly next: NextAction
  readonly pr: string | null
}

const Answer = Schema.Struct({ words: Schema.String, at: Schema.String })
const Question = Schema.Struct({ id: Schema.String, text: Schema.String, blocks: Schema.Boolean, deciderOwns: Schema.Boolean, answer: Schema.NullOr(Answer) })
type Question = typeof Question.Type
const Parked = Schema.Struct({
  origin: Schema.optionalKey(Schema.Struct({ pr: Schema.optionalKey(Schema.String) })),
  questions: Schema.Array(Question)
})
const Waiting = Schema.Struct({ kind: Schema.Literals(["no-priority", "decision", "held", "parked", "depends", "room"]) })
type WaitingKind = typeof Waiting.Type["kind"]

const taskFields = {
  id: Schema.String,
  title: Schema.String,
  prState: Schema.NullOr(Schema.Literals(["open", "closed", "merged"])),
  parked: Schema.NullOr(Parked)
}
const Task = Schema.Union([
  Schema.Struct({ ...taskFields, status: Schema.Literal("new"), waiting: Schema.NullOr(Waiting) }),
  Schema.Struct({ ...taskFields, status: Schema.Literals(["taken", "started"]) }),
  Schema.Struct({ ...taskFields, status: Schema.Literal("closed"), outcome: Schema.String, pr: Schema.NullOr(Schema.String) })
])
type Task = typeof Task.Type
const Backlog = Schema.Struct({ schema: Schema.Literal("orc.backlog.v1"), tasks: Schema.Array(Task) })

const ciWaitingQuestion = "ci-waiting"
const prUrl = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/
const fullPrPattern = new RegExp("^" + prUrl.source + "$")
const fullPrUrl = (value: string | null | undefined): string | null => value !== null && value !== undefined && fullPrPattern.test(value) ? value : null

const blockingQuestions = (task: Task): ReadonlyArray<Question> =>
  task.parked?.questions.filter((question) => question.blocks && question.answer === null) ?? []

const prOf = (task: Task): string | null => {
  if (task.status === "closed") return fullPrUrl(task.pr)
  const asked = task.parked?.questions.find((question) => question.id === ciWaitingQuestion && question.answer === null)
  return asked?.text.match(prUrl)?.[0] ?? fullPrUrl(task.parked?.origin?.pr)
}

const newNext = (wait: WaitingKind, questions: ReadonlyArray<Question>): NextAction => {
  switch (wait) {
    case "no-priority": return { waits: "priority", actor: "owner" }
    case "decision": return { waits: "decision", actor: "owner" }
    case "held": return { waits: "hold", actor: "owner" }
    case "parked": {
      if (questions.length === 1 && questions[0]?.id === ciWaitingQuestion) return { waits: "ci", actor: "ci" }
      const answers = questions.filter((question) => question.id !== ciWaitingQuestion)
      const actor = answers.length > 0 && answers.every((question) => question.deciderOwns) ? "orc" : "owner"
      return { waits: "answer", actor, questions: questions.map((question) => question.id) }
    }
    case "depends": return { waits: "dependency", actor: "orc" }
    case "room": return { waits: "room", actor: "orc" }
  }
}

const laterNext = (task: Task): NextAction => {
  switch (task.status) {
    case "new": return { waits: "nothing" }
    case "taken":
    case "started": return { waits: "run", actor: "orc" }
    case "closed": {
      if (task.prState === "open") return { waits: "pull-request", actor: "owner" }
      return task.outcome === "failed" || task.outcome === "start-failed" ? { waits: "failed-run", actor: "owner" } : { waits: "nothing" }
    }
  }
}

const taskNext = (task: Task): TaskNext => ({
  id: task.id,
  title: task.title,
  next: task.status === "new" && task.waiting !== null ? newNext(task.waiting.kind, blockingQuestions(task)) : laterNext(task),
  pr: prOf(task)
})

const decodeBacklog = Schema.decodeUnknownEffect(Backlog)

export const boardNext = (value: unknown): Effect.Effect<ReadonlyArray<TaskNext>, Schema.SchemaError> =>
  decodeBacklog(value).pipe(Effect.map(({ tasks }) => tasks.map(taskNext)))
