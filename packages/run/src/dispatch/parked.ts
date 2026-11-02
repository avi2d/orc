import { Array as Arr, Effect, FileSystem } from "effect"
import type { OpenQuestion } from "../no-mistakes-gate"
import { backlogPaths, findTask, type Rewrite, rewriteNew } from "./backlog"
import { BacklogError, platformFailure, publishOnce, scratchName } from "./backlog-write"
import { type Hold, isHeld, openQuestions, type Parked, type ParkedQuestion, parseTaskFile, renderTaskFile, type TaskFileError, type TaskRecord } from "./task-record"

const parkedQuestions = (open: Arr.NonEmptyReadonlyArray<OpenQuestion>, before: TaskRecord): Parked["questions"] => {
  const answered = before.parked?.questions.filter((question) => question.answer !== null && !open.some((asked) => asked.id === question.id)) ?? []
  return Arr.appendAll(Arr.map(open, (question) => ({ ...question, answer: null })), answered)
}

// rename(2) takes the taken file at most once, so of two beats parking one run exactly one moves it back to new.
export const parkStartedTask = (
  root: string,
  id: string,
  branch: string,
  open: Arr.NonEmptyReadonlyArray<OpenQuestion>
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = backlogPaths(root)
    const file = paths.taskFile("taken", id)
    const grabbed = scratchName(paths.folder("taken"), id)
    const took = yield* fs.rename(file, grabbed).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.mapError(platformFailure("take " + id))
    )
    if (!took) {
      return yield* new BacklogError({ detail: id + " was parked or closed by another command" })
    }
    const putBack = fs.rename(grabbed, file).pipe(Effect.mapError(platformFailure("put back " + id)))
    const park = Effect.gen(function*() {
      const text = yield* fs.readFileString(grabbed).pipe(Effect.mapError(platformFailure("read " + grabbed)))
      const record = yield* parseTaskFile(file, "taken", text)
      if (record.state.kind !== "started") {
        return yield* new BacklogError({ detail: id + " is " + record.state.kind + ", and only a started task parks" })
      }
      const parked: TaskRecord = { ...record, parked: { branch, questions: parkedQuestions(open, record) }, state: { kind: "new" } }
      if (!(yield* publishOnce(paths.folder("new"), id, renderTaskFile(parked)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return parked
    })
    const parked = yield* park.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return parked
  })

export type AnswerOutcome =
  | { readonly kind: "hold"; readonly hold: Hold }
  | { readonly kind: "question"; readonly question: string; readonly branch: string; readonly open: ReadonlyArray<ParkedQuestion> }

const answerQuestionOn = (id: string, words: string, at: string, fresh: TaskRecord & { readonly parked: Parked }): Effect.Effect<Rewrite<AnswerOutcome>, BacklogError> => {
  const open = openQuestions(fresh)
  if (open.length === 0) {
    return Effect.fail(new BacklogError({ detail: id + " is not parked: its questions were answered" }))
  }
  const cut = words.indexOf("=")
  const question = cut === -1 ? "" : words.slice(0, cut)
  const text = cut === -1 ? "" : words.slice(cut + 1)
  const asked = fresh.parked.questions.find((candidate) => candidate.id === question)
  if (asked === undefined || text.trim() === "") {
    return Effect.fail(new BacklogError({ detail: id + " is parked for the captain's answer to " + open.map((candidate) => candidate.id).join(", ") + ", so answer one as <question-id>=<text>" }))
  }
  if (asked.answer !== null) {
    return Effect.fail(new BacklogError({ detail: id + " already has an answer to " + question + ": " + asked.answer.words }))
  }
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" }))
  }
  const questions = Arr.map(fresh.parked.questions, (candidate) => candidate === asked ? { ...candidate, answer: { words: text, at } } : candidate)
  const answered: TaskRecord = { ...fresh, parked: { ...fresh.parked, questions } }
  return Effect.succeed({ kind: "write", record: answered, result: { kind: "question", question, branch: fresh.parked.branch, open: openQuestions(answered) } })
}

const answerOn = (id: string, words: string, at: string) => (fresh: TaskRecord): Effect.Effect<Rewrite<AnswerOutcome>, BacklogError> => {
  if (fresh.parked !== null) {
    return answerQuestionOn(id, words, at, { ...fresh, parked: fresh.parked })
  }
  if (!isHeld(fresh)) {
    return Effect.fail(new BacklogError({ detail: id + " is not held" + (fresh.hold?.answer == null ? "" : ": its hold was answered") }))
  }
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" }))
  }
  const answered: Hold = { ...fresh.hold, answer: { words, at } }
  return Effect.succeed({ kind: "write", record: { ...fresh, hold: answered }, result: { kind: "hold", hold: answered } })
}

export const answerTask = (
  root: string,
  id: string,
  words: string,
  at: string
): Effect.Effect<AnswerOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decide = answerOn(id, words, at)
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })

