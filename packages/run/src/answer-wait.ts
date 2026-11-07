import { Console, Duration, Effect, FileSystem, Schema } from "effect"
import { readJsonFileIfPresent } from "./json-file"
import { OrcRunError } from "./run-session"
import type { NoMistakesFinding, OpenQuestion, QuestionAnswer } from "./no-mistakes-gate"

export const askingFileName = "asking.json"
export const answersFileName = "answers.json"

export const Asking = Schema.Struct({
  until: Schema.String,
  questions: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))
})

export const RelayedAnswers = Schema.Array(Schema.Struct({ question: Schema.String, answer: Schema.String.check(Schema.isNonEmpty()) }))

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

// rename(2) replaces the file whole, so a reader never sees half of it.
export const writeWhole = (file: string, text: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const scratch = file + "." + crypto.randomUUID().slice(0, 8) + ".tmp"
    return yield* fs.writeFileString(scratch, text).pipe(
      Effect.andThen(fs.rename(scratch, file)),
      Effect.as(true),
      Effect.catchTag("PlatformError", () => fs.remove(scratch, { force: true }).pipe(Effect.orElseSucceed(() => undefined), Effect.as(false)))
    )
  })

const readRelayed = (file: string): Effect.Effect<ReadonlyArray<QuestionAnswer>, never, FileSystem.FileSystem> =>
  readJsonFileIfPresent(file, RelayedAnswers).pipe(Effect.map((answers) => answers ?? []), Effect.orElseSucceed(() => []))

// answers.json counts only while asking.json stands, and the wait removes both as it ends.
export const waitForAnswers = (runDir: string, waitSeconds: number) =>
  (missing: ReadonlyArray<Pick<NoMistakesFinding, "id" | "description">>): Effect.Effect<ReadonlyArray<QuestionAnswer>, never, FileSystem.FileSystem> =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const asking = runDir + "/" + askingFileName
      const relayed = runDir + "/" + answersFileName
      const deadline = Date.now() + waitSeconds * 1000
      const questions: ReadonlyArray<OpenQuestion> = missing.map((finding) => ({ id: finding.id, text: finding.description }))
      const until = new Date(deadline).toISOString()
      if (waitSeconds === 0 || !(yield* writeWhole(asking, JSON.stringify({ until, questions })))) {
        return []
      }
      yield* Console.log("orc: no-mistakes waits until " + until + " for the captain's answer to " + questions.map((question) => question.id).join(", ") + ", read from " + relayed)
      const answeredOf = (answers: ReadonlyArray<QuestionAnswer>) => answers.filter((entry) => missing.some((finding) => finding.id === entry.question))
      let answered = answeredOf(yield* readRelayed(relayed))
      while (answered.length < missing.length && Date.now() < deadline) {
        yield* Effect.sleep(Duration.seconds(Math.min(pollSeconds, Math.max(0, (deadline - Date.now()) / 1000))))
        answered = answeredOf(yield* readRelayed(relayed))
      }
      yield* fs.remove(asking, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      yield* fs.remove(relayed, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      return answered
    })
