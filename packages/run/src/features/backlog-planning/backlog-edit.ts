import { Effect, type FileSystem, type Path } from "effect"
import { BacklogError, findTask, type Rewrite, rewriteNew, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { type AddPlace, readTaskText, type TaskSource, titleOf } from "./cli-add"

export type EditTask = {
  readonly kind: "EditTask"
  readonly id: string
  readonly task: TaskSource
}

export interface EditText {
  readonly title: string
  readonly body: string
}

export type EditOutcome = "edited"

const editOn = (id: string, text: EditText) => (fresh: TaskRecord): Effect.Effect<Rewrite<EditOutcome>, BacklogError> => {
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " is " + fresh.state.kind + ", and a run has read its text, so only a new task is edited" }))
  }
  return Effect.succeed({ kind: "write", record: { ...fresh, spec: { ...fresh.spec, title: text.title, body: text.body } }, result: "edited" })
}

export const editTask = (
  root: string,
  id: string,
  text: EditText
): Effect.Effect<EditOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decide = editOn(id, text)
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })

export const edit = (
  root: string,
  args: EditTask,
  place: AddPlace
): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const { from, body } = yield* readTaskText(args.task, place, "orc backlog edit")
    const title = titleOf(body)
    if (title === "") {
      return yield* new BacklogError({ detail: from + " holds no title" })
    }
    yield* editTask(root, args.id, { title, body })
    return "edited " + args.id + ": " + title
  })
