import { nextHold, type Hold, type Parked, type TaskRecord } from "../backlog/index"
import { isBlockingQuestion } from "../review-gate/index"

// A resume hands back only the answers the task already holds, so a resumed run that parks with nothing open and nothing answered during it would end the same way on every beat.
export const repeatsResume = (record: TaskRecord, questions: Parked["questions"]): boolean => {
  if (record.state.kind !== "started" || record.parked?.origin === undefined) {
    return false
  }
  const started = Date.parse(record.state.started.at)
  const blockingReady = questions.filter(isBlockingQuestion).every((question) => question.answer !== null)
  const fresh = questions.some((question) => question.answer !== null && Date.parse(question.answer.at) >= started)
  return blockingReady && !fresh
}

export const repeatHold = (record: TaskRecord, run: string | undefined, ended: string | undefined, at: string): Hold => {
  const reason = "the resumed run " + (run ?? record.parked?.origin?.run ?? "") + " ended with no new blocking question and no answer given during it" +
    (ended === undefined || ended.trim() === "" ? "" : " (" + ended.trim() + ")") + ", so the beat stops resuming it with the same answers"
  return nextHold(record.hold, { reason, until: null, questions: [], answer: null, at, repeat: true })
}
