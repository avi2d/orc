import { type AskedQuestion, isWorkerQuestion } from "../../entities/agent/index"
import { isSendBackQuestion } from "../../entities/parked-runs/index"
import { deciderLabel } from "../../shared/lib/index"
import type { QuestionAnswer } from "../../entities/review-gate/index"

export const askedNote = (question: AskedQuestion): string =>
  "orc stopped Pi when no answer to its question " + question.id + " came in time: " + question.text

export const workerAnswersOf = (answers: ReadonlyArray<QuestionAnswer>): ReadonlyArray<QuestionAnswer> =>
  answers.filter((answer) => isWorkerQuestion(answer.question))

export const workerGuidance = (answers: ReadonlyArray<QuestionAnswer>): string =>
  answers.map((answer) => (answer.decider === undefined ? "An answer was recorded for your question " : deciderLabel(answer.decider) + " answered your question ") + answer.question + ": " + answer.answer).join("\n")

export const workerContinuePrompt = (answers: ReadonlyArray<QuestionAnswer>): string =>
  workerGuidance(answers) + "\nCarry on with the task as first asked, and end it the way the first prompt said."

export const sentBackWordsOf = (answers: ReadonlyArray<QuestionAnswer>): ReadonlyArray<string> =>
  answers.filter((answer) => isSendBackQuestion(answer.question)).map((answer) => answer.answer)

export const sentBackGuidance = (words: ReadonlyArray<string>): string =>
  "The captain reviewed the pull request this branch opened and sent it back: " + words.join("\nThe captain also wrote: ") + "\nChange the branch to answer that review, and commit the change on it."

export const sentBackContinuePrompt = (words: ReadonlyArray<string>): string =>
  sentBackGuidance(words) + "\nThen end it the way the first prompt said."
