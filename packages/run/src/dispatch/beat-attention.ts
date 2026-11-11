import { Effect, type FileSystem } from "effect"
import { isOverdue, readAttention, reviewQuestionId } from "./attention"
import type { BeatAction } from "./beat-action"
import type { BacklogError } from "./backlog-write"
import type { TaskRecord } from "./task-record"

export const attentionActions = (
  root: string,
  tasks: ReadonlyArray<TaskRecord>,
  actions: ReadonlyArray<BeatAction>,
  at: string
): Effect.Effect<{ readonly reported: ReadonlyArray<BeatAction>; readonly queue: ReadonlyArray<BeatAction> }, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const attention = yield* readAttention(root, tasks)
    const deciderOwned = new Set([...attention.open, ...attention.decided].filter(({ item }) => item.owner === "decider").map(({ id }) => id))
    const ownedByDecider = (task: string) => (id: string): boolean => {
      const question = tasks.find((entry) => entry.spec.id === task)?.parked?.questions.find((entry) => entry.id === id)
      return question !== undefined && deciderOwned.has(reviewQuestionId(task, id, question.asked))
    }
    const reported = actions.flatMap((action): ReadonlyArray<BeatAction> => {
      if (action.kind === "parked") {
        const decides = ownedByDecider(action.task)
        const all = [...action.questions, ...action.decider]
        return [{ ...action, questions: all.filter((id) => !decides(id)), decider: all.filter(decides) }]
      }
      if (action.kind !== "asking") {
        return [action]
      }
      const questions = action.questions.filter((id) => !ownedByDecider(action.task)(id))
      return questions.length === 0 ? [] : [{ ...action, questions }]
    })
    const queue = attention.open.map(({ id, item }): BeatAction => ({
      kind: "attention", item: id, task: item.task, owner: item.owner, overdue: isOverdue(item, Date.parse(at)), text: item.text
    }))
    return { reported, queue }
  })
