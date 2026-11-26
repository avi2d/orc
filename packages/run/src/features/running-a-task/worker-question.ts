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

export const sentBackAnswersOf = (answers: ReadonlyArray<QuestionAnswer>): ReadonlyArray<QuestionAnswer> =>
  answers.filter((answer) => isSendBackQuestion(answer.question))

const sentBackBy = (answer: QuestionAnswer, first: boolean): string => {
  const by = answer.decider === undefined ? "" : deciderLabel(answer.decider)
  if (first) {
    return (by === "" ? "The pull request this branch opened was sent back" : by + " sent back the pull request this branch opened") + ": "
  }
  return (by === "" ? "Also recorded" : by + " also wrote") + ": "
}

export const sentBackGuidance = (answers: ReadonlyArray<QuestionAnswer>): string =>
  answers.map((answer, index) => sentBackBy(answer, index === 0) + answer.answer).join("\n") + "\nChange the branch to answer that review, and commit the change on it."

export const sentBackContinuePrompt = (answers: ReadonlyArray<QuestionAnswer>): string =>
  sentBackGuidance(answers) + "\nThen end it the way the first prompt said."
