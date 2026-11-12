import { Effect, Schema } from "effect"
import { reviewQuestionId } from "./entities/attention/index"

export const QuestionJson = Schema.Struct({ id: Schema.String, text: Schema.String, answer: Schema.NullOr(Schema.Struct({ words: Schema.String, at: Schema.String })) })

export const ParkedJson = Schema.Struct({
  branch: Schema.String,
  questions: Schema.Array(Schema.Struct({ ...QuestionJson.fields, asked: Schema.String }))
})

export const HoldJson = Schema.Struct({
  reason: Schema.String,
  until: Schema.NullOr(Schema.String),
  questions: Schema.Array(QuestionJson),
  answer: Schema.NullOr(Schema.Struct({ words: Schema.String, at: Schema.String }))
})
export type HoldJson = typeof HoldJson.Type

interface ParkedTask {
  readonly id: string
  readonly title: string
  readonly parked?: typeof ParkedJson.Type | null
}

export const AttentionJson = Schema.fromJsonString(Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, owner: Schema.Literals(["decider", "user"]) })),
  decided: Schema.Array(Schema.Struct({ id: Schema.String, owner: Schema.Literals(["decider", "user"]) }))
}))

interface ParkedListing {
  readonly post: Effect.Effect<void>
  readonly forget: () => void
}

const parkedLines = (task: ParkedTask, deciderOwned: ReadonlySet<string>): ReadonlyArray<{ readonly key: string; readonly line: string }> => {
  if (task.parked === undefined || task.parked === null) {
    return []
  }
  const branch = task.parked.branch
  return task.parked.questions.flatMap((question) =>
    question.answer === null && !deciderOwned.has(reviewQuestionId(task.id, question.id, question.asked))
      ? [{
        key: JSON.stringify([task.id, branch, question.id, question.text, question.asked]),
        line: task.id + " " + task.title + " is parked on " + branch + " for the captain's answer to " + question.id + (question.text === "" ? "" : ": " + question.text)
      }]
      : []
  )
}

// A question counts as shown only once Pi took its line, so a failed read or a busy Pi lists it on a later poll.
export const parkedListing = <E extends { readonly message: string }>(
  read: Effect.Effect<{ readonly tasks: ReadonlyArray<ParkedTask>; readonly deciderOwned: ReadonlySet<string> }, E>,
  deliver: (text: string) => boolean
): ParkedListing => {
  const shown = new Set<string>()
  let unreadBecause: string | null = null
  const post = read.pipe(
    Effect.map(({ tasks, deciderOwned }) => {
      unreadBecause = null
      for (const entry of tasks.flatMap((task) => parkedLines(task, deciderOwned))) {
        if (!shown.has(entry.key) && deliver(entry.line)) {
          shown.add(entry.key)
        }
      }
    }),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error.message !== unreadBecause && deliver("orc chat cannot list the parked questions: " + error.message)) {
          unreadBecause = error.message
        }
      })
    )
  )
  return { post, forget: () => shown.clear() }
}
