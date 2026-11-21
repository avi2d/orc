import { ownerFindingsIn } from "./no-mistakes-gate"
import { Console, Duration, Effect, FileSystem, Schema } from "effect"
import { readJsonFileIfPresent, writeWhole } from "../../shared/config/index"
import { OrcRunError } from "../../shared/lib/index"
import type { NoMistakesFinding, QuestionAnswer } from "./no-mistakes-gate"

export const askingFileName = "asking.json"
export const answersFileName = "answers.json"
export const correctionsFileName = "corrections.json"

export const AskOption = Schema.Struct({ text: Schema.String, picture: Schema.optionalKey(Schema.String) })

export type AskOption = typeof AskOption.Type

const AskingQuestion = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  options: Schema.optionalKey(Schema.Array(AskOption)),
  blocks: Schema.optional(Schema.Boolean),
  asked: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.Literal("user"))
})

type AskingQuestion = typeof AskingQuestion.Type

export const Asking = Schema.Struct({
  asked: Schema.String,
  until: Schema.String,
  questions: Schema.Array(AskingQuestion)
})

const RelayedAnswers = Schema.Array(Schema.Struct({ question: Schema.String, answer: Schema.String.check(Schema.isNonEmpty()) }))

export const AnswersFile = Schema.Struct({ asking: Schema.String, answers: RelayedAnswers })

export const CorrectionsFile = Schema.Struct({ corrections: RelayedAnswers })

export interface WaitResult {
  readonly asked: string | null
  readonly answers: ReadonlyArray<QuestionAnswer>
}

const defaultAnswerWaitSeconds = 30 * 60

const pollSeconds = 5

export const answerWaitFromEnv = (value: string | undefined): Effect.Effect<number, OrcRunError> => {
  const text = (value ?? "").trim()
  if (text === "") {
    return Effect.succeed(defaultAnswerWaitSeconds)
  }
  return /^(0|[1-9]\d*)$/.test(text)
    ? Effect.succeed(Number(text))
    : Effect.fail(new OrcRunError({ message: "orc: ORC_ANSWER_WAIT_SECONDS is " + text + ", which is not a whole number of seconds" }))
}

export const isBlockingQuestion = (question: { readonly blocks?: boolean | undefined }): boolean =>
  question.blocks !== false

export const hasBlockingQuestion = (asking: { readonly questions: ReadonlyArray<{ readonly blocks?: boolean | undefined }> }): boolean =>
  asking.questions.some(isBlockingQuestion)

const dropAnswersFor = (relayed: string, missing: ReadonlyArray<Pick<NoMistakesFinding, "id" | "description">>, asked: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  readJsonFileIfPresent(relayed, AnswersFile).pipe(
    Effect.flatMap((stored) => {
      if (stored === null || stored.asking !== asked) {
        return Effect.void
      }
      const kept = stored.answers.filter((entry) => !missing.some((finding) => finding.id === entry.question))
      return kept.length === stored.answers.length
        ? Effect.void
        : writeWhole(relayed, JSON.stringify({ asking: asked, answers: kept })).pipe(Effect.asVoid, Effect.orElseSucceed(() => undefined))
    }),
    Effect.orElseSucceed(() => undefined)
  )

const readRelayed = (file: string, asked: string): Effect.Effect<ReadonlyArray<QuestionAnswer>, never, FileSystem.FileSystem> =>
  readJsonFileIfPresent(file, AnswersFile).pipe(
    Effect.map((relayed) => relayed === null || relayed.asking !== asked ? [] : relayed.answers),
    Effect.orElseSucceed(() => [])
  )

export const waitForAnswers = (runDir: string, waitSeconds: number, waiter: string) =>
  (missing: ReadonlyArray<Pick<NoMistakesFinding, "id" | "description" | "action">>): Effect.Effect<WaitResult, never, FileSystem.FileSystem> =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const asking = runDir + "/" + askingFileName
      const relayed = runDir + "/" + answersFileName
      if (waitSeconds === 0) {
        return { asked: null, answers: [] }
      }
      const now = new Date().toISOString()
      const previous = yield* readJsonFileIfPresent(asking, Asking).pipe(Effect.orElseSucceed(() => null))
      yield* dropAnswersFor(relayed, missing, previous?.asked ?? now)
      const asked = previous?.asked ?? now
      const deadline = Date.now() + waitSeconds * 1000
      const until = new Date(deadline).toISOString()
      const owned = new Set(ownerFindingsIn(missing).map((finding) => finding.id))
      const fresh: ReadonlyArray<AskingQuestion> = missing.map((finding) => ({ id: finding.id, text: finding.description, blocks: true, asked: asked, ...(owned.has(finding.id) ? { owner: "user" as const } : {}) }))
      const kept = (previous?.questions ?? []).filter((question) => !missing.some((finding) => finding.id === question.id))
      const merged = [...kept, ...fresh]
      if (!(yield* writeWhole(asking, JSON.stringify({ asked, until, questions: merged })))) {
        return { asked: null, answers: [] }
      }
      yield* Console.log("orc: " + waiter + " waits until " + until + " for the captain's answer to " + missing.map((finding) => finding.id).join(", ") + ", read from " + relayed)
      const answeredOf = (answers: ReadonlyArray<QuestionAnswer>) => answers.filter((entry) => missing.some((finding) => finding.id === entry.question))
      let answered = answeredOf(yield* readRelayed(relayed, asked))
      while (answered.length < missing.length && Date.now() < deadline) {
        yield* Effect.sleep(Duration.seconds(Math.min(pollSeconds, Math.max(0, (deadline - Date.now()) / 1000))))
        answered = answeredOf(yield* readRelayed(relayed, asked))
      }
      const remaining = (yield* readJsonFileIfPresent(asking, Asking).pipe(Effect.orElseSucceed(() => null)))?.questions.filter((question) => !missing.some((finding) => finding.id === question.id)) ?? []
      if (remaining.length === 0) {
        yield* fs.remove(asking, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
        yield* fs.remove(relayed, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      } else {
        const nextUntil = remaining.some(isBlockingQuestion) ? until : asked
        yield* writeWhole(asking, JSON.stringify({ asked, until: nextUntil, questions: remaining })).pipe(Effect.orElseSucceed(() => false))
      }
      return { asked, answers: answered }
    })
