import { isHeld, openQuestions, type ParkedQuestion, type TaskRecord } from "./task-record"

const heldReason = (task: TaskRecord): string | null =>
  isHeld(task) ? "held for the captain: " + task.hold.reason + (task.hold.until === null ? "" : ", until " + task.hold.until) : null

export const decisionWait = "decision for the captain"

export type DeciderOwns = (task: string, question: ParkedQuestion) => boolean

export const answersAwaited = (captain: ReadonlyArray<string>, decider: ReadonlyArray<string>): string =>
  [
    ...(captain.length === 0 ? [] : ["the captain's answer to " + captain.join(", ")]),
    ...(decider.length === 0 ? [] : ["the decider's answer to " + decider.join(", ")])
  ].join(" and ")

const parkedReason = (task: TaskRecord, deciderOwns: DeciderOwns): string | null => {
  const open = openQuestions(task).filter((question) => question.blocks)
  if (task.parked === null || open.length === 0) {
    return null
  }
  const owned = (question: ParkedQuestion): boolean => deciderOwns(task.spec.id, question)
  const ids = (questions: ReadonlyArray<ParkedQuestion>): ReadonlyArray<string> => questions.map((question) => question.id)
  return "parked on " + task.parked.branch + " for " + answersAwaited(ids(open.filter((question) => !owned(question))), ids(open.filter(owned)))
}

export const answerWait = (task: TaskRecord, deciderOwns: DeciderOwns): string | null => heldReason(task) ?? parkedReason(task, deciderOwns)

export const missingOriginWait = (id: string): string =>
  "the parked task has no recorded machine and run; record them with orc backlog origin " + id + " <machine> <run-id> before resuming"
