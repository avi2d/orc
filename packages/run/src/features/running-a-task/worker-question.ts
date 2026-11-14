import { type AskedQuestion, isWorkerQuestion } from "../../entities/agent/index"
import type { QuestionAnswer } from "../../entities/review-gate/index"

export const askedNote = (question: AskedQuestion): string =>
  "orc stopped Pi when no answer to its question " + question.id + " came in time: " + question.text

export const workerAnswersOf = (answers: ReadonlyArray<QuestionAnswer>): ReadonlyArray<QuestionAnswer> =>
  answers.filter((answer) => isWorkerQuestion(answer.question))

export const workerGuidance = (answers: ReadonlyArray<QuestionAnswer>): string =>
  answers.map((answer) => "The captain answered your question " + answer.question + ": " + answer.answer).join("\n")

export const workerContinuePrompt = (answers: ReadonlyArray<QuestionAnswer>): string =>
  workerGuidance(answers) + "\nCarry on with the task as first asked, and end it the way the first prompt said."
