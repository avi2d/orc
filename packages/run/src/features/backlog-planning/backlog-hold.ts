import { Effect, FileSystem } from "effect"
import { findTask, type Rewrite, rewriteNew, type Hold, type HoldQuestion, type TaskFileError, type TaskRecord, BacklogError } from "../../entities/backlog/index"

export type HoldOutcome = { readonly kind: "held" | "already held"; readonly hold: Hold }

export interface HoldAsk {
  readonly reason: string
  readonly until: string | null
  readonly questions: ReadonlyArray<string>
}

const askedQuestions = (texts: ReadonlyArray<string>): ReadonlyArray<HoldQuestion> =>
  texts.map((text, index) => ({ id: "question-" + String(index + 1), text, answer: null }))

const asksTheSame = (held: ReadonlyArray<HoldQuestion>, texts: ReadonlyArray<string>): boolean =>
  held.length === texts.length && held.every((question, index) => question.text === texts[index])

const holdAgain = (id: string, fresh: TaskRecord, held: Hold, ask: HoldAsk): Effect.Effect<Rewrite<HoldOutcome>, BacklogError> => {
  if (ask.questions.length === 0 || asksTheSame(held.questions, ask.questions)) {
    return Effect.succeed({ kind: "keep", result: { kind: "already held", hold: held } })
  }
  if (held.questions.length > 0) {
    return Effect.fail(new BacklogError({ detail: id + " is already held on " + held.questions.map((question) => question.id).join(", ") + ", so answer those first" }))
  }
  return Effect.fail(new BacklogError({ detail: id + " is already held: " + held.reason + ", so answer it first" }))
}

const holdOn = (id: string, ask: HoldAsk) => (fresh: TaskRecord): Effect.Effect<Rewrite<HoldOutcome>, BacklogError> => {
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " is " + fresh.state.kind + ", and only a new task is held" }))
  }
  if (fresh.parked !== null) {
    return Effect.fail(new BacklogError({ detail: id + " is parked for the captain's answer, so it cannot be held" }))
  }
  if (fresh.hold?.answer != null) {
    return Effect.fail(new BacklogError({ detail: id + " was held and answered: " + fresh.hold.answer.words }))
  }
  if (fresh.hold !== null) {
    return holdAgain(id, fresh, fresh.hold, ask)
  }
  const held: Hold = { reason: ask.reason, until: ask.until, questions: askedQuestions(ask.questions), answer: null }
  return Effect.succeed({ kind: "write", record: { ...fresh, hold: held }, result: { kind: "held", hold: held } })
}

// A taken task belongs to a live beat that goes on writing its taken file, so only a new one is rewritten.
export const holdTask = (
  root: string,
  id: string,
  ask: HoldAsk
): Effect.Effect<HoldOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decide = holdOn(id, ask)
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })
