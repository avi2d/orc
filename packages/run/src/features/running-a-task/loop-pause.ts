import { Data, Effect, type FileSystem } from "effect"
import { loopQuestionId, pauseAfterFailures, type PiEnd } from "../../entities/agent/index"
import { type OpenQuestion, type QuestionAnswer, waitForAnswers } from "../../entities/review-gate/index"

export class RunStopped extends Data.TaggedError("RunStopped")<{
  readonly reason: string
}> {}

export type Looping = Extract<PiEnd, { readonly kind: "looping" }>

export type LoopAnswer =
  | { readonly kind: "continue"; readonly words: string }
  | { readonly kind: "stop"; readonly reason: string }

export type LoopVerdict =
  | LoopAnswer
  | { readonly kind: "unanswered"; readonly question: OpenQuestion & { readonly asked: string } }

const failedInARow = (label: string): string => "Pi failed " + label + " " + pauseAfterFailures.toString() + " times in a row"

export const loopingNote = (end: Looping): string =>
  "orc paused Pi after it failed " + end.label + " " + pauseAfterFailures.toString() + " times in a row, and no answer to continue or stop came in time."

const loopQuestionText = (label: string): string =>
  failedInARow(label) + ", so orc paused the run. Answer continue, with any guidance for Pi after it, to resume Pi, or stop to end the run. " +
  "Continuing spends more of the account's quota."

// A misread answer stops the run, which spends nothing, so only words that open with continue resume Pi.
export const readLoopAnswer = (words: string): LoopAnswer =>
  /^\s*continue\b/i.test(words)
    ? { kind: "continue", words: words.trim() }
    : { kind: "stop", reason: "The captain stopped the run when it paused on a failing command, answering: " + words.trim() }

export const loopAnswerOf = (answers: ReadonlyArray<QuestionAnswer>): LoopAnswer | null => {
  const answer = answers.find((entry) => entry.question === loopQuestionId)
  return answer === undefined ? null : readLoopAnswer(answer.answer)
}

export const askOnLoop = (runDir: string, waitSeconds: number, end: Looping): Effect.Effect<LoopVerdict, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const text = loopQuestionText(end.label)
    const waited = yield* waitForAnswers(runDir, waitSeconds, "the paused run")([{ id: loopQuestionId, description: text }])
    return loopAnswerOf(waited.answers) ?? { kind: "unanswered", question: { id: loopQuestionId, text, asked: waited.asked ?? new Date().toISOString() } }
  })

export const loopGuidance = (words: string): string =>
  [
    "orc paused you because one command failed " + pauseAfterFailures.toString() + " times in a row, and the captain answered: " + words,
    "Do not run that command again unchanged. Find out why it fails, or reach the task another way."
  ].join("\n")

export const loopContinuePrompt = (words: string): string =>
  loopGuidance(words) + "\nThen carry on with the task as first asked, and end it the way the first prompt said."
