import type { Hold } from "./task-record"

export const nextHold = (previous: Hold | null, hold: Omit<Hold, "history">): Hold => {
  const history = previous === null || previous.answer === null ? [] : [
    ...previous.history ?? [],
    { reason: previous.reason, until: previous.until, questions: previous.questions, answer: previous.answer, ...(previous.at === null ? {} : { at: previous.at }) }
  ]
  return { ...hold, ...(history.length === 0 ? {} : { history }) }
}
