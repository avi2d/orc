import { Console, Duration, Effect, FileSystem, Schema } from "effect"
import { readJsonFileIfPresent, writeWhole } from "../../shared/config/index"
import { OrcRunError } from "../../shared/lib/index"
import type { NoMistakesFinding, OpenQuestion, QuestionAnswer } from "./no-mistakes-gate"

export const askingFileName = "asking.json"
export const answersFileName = "answers.json"

export const Asking = Schema.Struct({
  asked: Schema.String,
  until: Schema.String,
  questions: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))
})

const RelayedAnswers = Schema.Array(Schema.Struct({ question: Schema.String, answer: Schema.String.check(Schema.isNonEmpty()) }))

export const AnswersFile = Schema.Struct({ asking: Schema.String, answers: RelayedAnswers })

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

// A relay that lands after a wait ended names the old asking, so the next wait does not take it.
const readRelayed = (file: string, asked: string): Effect.Effect<ReadonlyArray<QuestionAnswer>, never, FileSystem.FileSystem> =>
  readJsonFileIfPresent(file, AnswersFile).pipe(
    Effect.map((relayed) => relayed === null || relayed.asking !== asked ? [] : relayed.answers),
    Effect.orElseSucceed(() => [])
  )

// answers.json counts only while asking.json stands, and the wait removes both as it ends.
export const waitForAnswers = (runDir: string, waitSeconds: number, waiter: string) =>
  (missing: ReadonlyArray<Pick<NoMistakesFinding, "id" | "description">>): Effect.Effect<WaitResult, never, FileSystem.FileSystem> =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const asking = runDir + "/" + askingFileName
      const relayed = runDir + "/" + answersFileName
      const asked = new Date().toISOString()
      const deadline = Date.parse(asked) + waitSeconds * 1000
      const questions: ReadonlyArray<OpenQuestion> = missing.map((finding) => ({ id: finding.id, text: finding.description }))
      const until = new Date(deadline).toISOString()
      if (waitSeconds === 0 || !(yield* writeWhole(asking, JSON.stringify({ asked, until, questions })))) {
        return { asked: null, answers: [] }
      }
      yield* Console.log("orc: " + waiter + " waits until " + until + " for the captain's answer to " + questions.map((question) => question.id).join(", ") + ", read from " + relayed)
      const answeredOf = (answers: ReadonlyArray<QuestionAnswer>) => answers.filter((entry) => missing.some((finding) => finding.id === entry.question))
      let answered = answeredOf(yield* readRelayed(relayed, asked))
      while (answered.length < missing.length && Date.now() < deadline) {
        yield* Effect.sleep(Duration.seconds(Math.min(pollSeconds, Math.max(0, (deadline - Date.now()) / 1000))))
        answered = answeredOf(yield* readRelayed(relayed, asked))
      }
      yield* fs.remove(asking, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      yield* fs.remove(relayed, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      return { asked, answers: answered }
    })
