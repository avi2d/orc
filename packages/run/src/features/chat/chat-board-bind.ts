import { type BacklogTask, type Decision, parkedReason } from "./chat-backlog"
import type { BoardCardRecord, BoardRecord } from "./chat-board-page"

export const matchesRecord = (task: Decision, record: BoardRecord): boolean => {
  if (task.waits !== record.waits || task.reason !== record.reason) {
    return false
  }
  const covers = record.cards.every((card) => {
    const target = card.target
    if (target.kind === "reason") {
      return task.questions.length === 0 && card.text === task.reason
    }
    const question = task.questions.find((candidate) => candidate.id === target.id)
    return question !== undefined && question.text === card.text
  })
  return covers && task.questions.filter((question) => question.answer === null).every((question) =>
    record.cards.some((card) => {
      const target = card.target
      return target.kind === "question" && target.id === question.id
    }))
}

export const completedWords = (record: BoardRecord, task: BacklogTask) => (card: BoardCardRecord): string | null => {
  if (task.id !== record.task) {
    return null
  }
  if (record.waits === "held") {
    if (task.hold === null || task.hold.reason !== record.reason) {
      return null
    }
    const target = card.target
    if (target.kind === "reason") {
      return task.hold.answer?.words ?? null
    }
    const question = task.hold.questions.find((candidate) => candidate.id === target.id)
    return question !== undefined && question.text === card.text ? question.answer?.words ?? null : null
  }
  if (task.parked === null || parkedReason(task.parked.branch) !== record.reason) {
    return null
  }
  const target = card.target
  if (target.kind !== "question") {
    return null
  }
  const question = task.parked.questions.find((candidate) => candidate.id === target.id)
  return question !== undefined && question.text === card.text ? question.answer?.words ?? null : null
}

export const answeredAlready = (bound: Decision, card: BoardCardRecord): boolean => {
  const target = card.target
  return target.kind === "question" && (bound.questions.find((question) => question.id === target.id)?.answer ?? null) !== null
}
