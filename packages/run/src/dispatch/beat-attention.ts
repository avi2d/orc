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
): Effect.Effect<{ readonly asking: ReadonlyArray<BeatAction>; readonly queue: ReadonlyArray<BeatAction> }, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const attention = yield* readAttention(root, tasks)
    const deciderOwned = new Set([...attention.open, ...attention.decided].filter(({ item }) => item.owner === "decider").map(({ id }) => id))
    const asking = actions.flatMap((action): ReadonlyArray<BeatAction> => {
      if (action.kind !== "asking") {
        return [action]
      }
      const task = tasks.find((entry) => entry.spec.id === action.task)
      const questions = action.questions.filter((id) => {
        const question = task?.parked?.questions.find((entry) => entry.id === id)
        return question === undefined || !deciderOwned.has(reviewQuestionId(action.task, id, question.asked))
      })
      return questions.length === 0 ? [] : [{ ...action, questions }]
    })
    const queue = attention.open.map(({ id, item }): BeatAction => ({
      kind: "attention", item: id, task: item.task, owner: item.owner, overdue: isOverdue(item, Date.parse(at)), text: item.text
    }))
    return { asking, queue }
  })
