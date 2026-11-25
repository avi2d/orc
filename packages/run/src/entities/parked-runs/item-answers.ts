import { Array as Arr, Effect, type FileSystem } from "effect"
import { type AttentionItem, readItem, reviewQuestionId } from "../attention/index"
import { type BacklogError, type ParkedAnswer, type ParkedQuestion, type Rewrite, rewriteNew, type TaskRecord } from "../backlog/index"

type Questions = ReadonlyArray<ParkedQuestion>

const questionKinds: ReadonlySet<AttentionItem["kind"]> = new Set<AttentionItem["kind"]>(["review-question", "worker-question"])

const decidedByDecider = (item: AttentionItem, at: string): boolean =>
  (item.decision?.kind === "answered" || item.decision?.kind === "duplicate") && item.decision.at === at

const recordedAnswer = (item: AttentionItem): ParkedAnswer | null => {
  const state = item.state
  if (state.kind !== "closed" || !questionKinds.has(item.kind)) {
    return null
  }
  const answer = { words: state.answer.words, at: state.answer.at, relayedTo: null }
  if (decidedByDecider(item, answer.at)) {
    return { ...answer, by: "decider" }
  }
  return state.overturned === undefined ? answer : { ...answer, overturned: { words: state.overturned.words, at: state.overturned.at, relayedTo: null, by: "decider" } }
}

const itemOf = (task: string, question: ParkedQuestion): string => reviewQuestionId(task, question.id, question.asked)

const recordedAnswers = (root: string, task: string, questions: Questions): Effect.Effect<ReadonlyMap<string, ParkedAnswer>, BacklogError, FileSystem.FileSystem> =>
  Effect.map(
    Effect.forEach(questions.filter((question) => question.answer === null), (question) =>
      Effect.map(readItem(root, itemOf(task, question)), (item) => {
        const answer = item === null ? null : recordedAnswer(item)
        return answer === null ? [] : [[itemOf(task, question), answer] as const]
      })),
    (entries) => new Map(entries.flat())
  )

// An unchanged question stays the same object, so a caller tells a rewrite from a keep by identity.
const withAnswers = (task: string, questions: Questions, recorded: ReadonlyMap<string, ParkedAnswer>): Questions =>
  Arr.map(questions, (question) => {
    const answer = question.answer === null ? recorded.get(itemOf(task, question)) : undefined
    return answer === undefined ? question : { ...question, answer }
  })

const changed = (before: Questions, after: Questions): boolean => after.some((question, index) => question !== before[index])

const carryInto = (root: string, task: TaskRecord, questions: Questions): Effect.Effect<TaskRecord, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const recorded = yield* recordedAnswers(root, task.spec.id, questions)
    if (recorded.size === 0) {
      return task
    }
    return yield* rewriteNew(root, task.spec.id, (fresh): Effect.Effect<Rewrite<TaskRecord>, BacklogError> => {
      if (fresh.state.kind !== "new" || fresh.parked === null) {
        return Effect.succeed({ kind: "keep", result: fresh })
      }
      const carried = withAnswers(fresh.spec.id, fresh.parked.questions, recorded)
      const record: TaskRecord = { ...fresh, parked: { ...fresh.parked, questions: carried } }
      return Effect.succeed(changed(fresh.parked.questions, carried) ? { kind: "write", record, result: record } : { kind: "keep", result: fresh })
    }).pipe(
      // Another command can hold the task file this beat, and the next beat carries the answer then.
      Effect.catchTags({ BacklogError: () => Effect.succeed(task), TaskFileError: () => Effect.succeed(task) })
    )
  })

// A task file that lost the answer its item recorded waits on that asking for good, so each beat writes the recorded answer back.
export const carryRecordedAnswers = (root: string, tasks: ReadonlyArray<TaskRecord>): Effect.Effect<ReadonlyArray<TaskRecord>, BacklogError, FileSystem.FileSystem> =>
  Effect.forEach(tasks, (task) => {
    const questions = task.parked?.questions
    return task.state.kind === "new" && questions !== undefined && questions.some((question) => question.answer === null)
      ? carryInto(root, task, questions)
      : Effect.succeed(task)
  })
