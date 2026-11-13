import { Effect, FileSystem } from "effect"
import { appendNote, findTask, type BacklogError, type TaskFileError } from "../../entities/backlog/index"

export const noteTask = (
  root: string,
  id: string,
  words: string,
  at: string
): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    yield* findTask(root, id)
    yield* appendNote(root, id, { at, who: "captain", text: words })
    return "noted on " + id
  })
