import { Effect, FileSystem } from "effect"
import { type Decider, deciderLabel } from "../../shared/lib/index"
import { decisionAnswer, isHeld, parseTaskFile, type TaskFileError, type TaskRecord } from "./task-record"
import { answeredReason } from "./task-record-decision"
import { closeNewTask } from "./close-new"
import { type BacklogError, backlogPaths, readIfPresent } from "./backlog-write"

export const decisionRefusal = (record: TaskRecord, verb: string): string | null =>
  record.spec.kind === "decision"
    ? record.spec.id + " is a decision, so it takes no " + verb + ": answer it with orc backlog answer " + record.spec.id + " or drop it with orc backlog close " + record.spec.id + " failed"
    : null

export const newTaskRefusal = (record: TaskRecord, id: string, verb: string, action: string): string | null =>
  decisionRefusal(record, verb) ?? (record.state.kind === "new" ? null : id + " is " + record.state.kind + ", and only a new task " + action)

const answeredRecord = (fresh: TaskRecord, words: string, at: string, decider: Decider): TaskRecord => ({
  ...fresh,
  hold: isHeld(fresh) ? null : fresh.hold,
  state: { kind: "closed", claim: null, closing: { outcome: "done", reason: answeredReason, answer: { words, at, decider } }, closedAt: at, postedAt: null }
})

export const answerDecision = (root: string, id: string, words: string, at: string, decider: Decider): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  closeNewTask(root, id, (fresh) => answeredRecord(fresh, words, at, decider))

const decisionNote = (decision: TaskRecord): string => {
  const answer = decisionAnswer(decision)
  return answer === null
    ? ""
    : "\n\nDecision " + decision.spec.id + " asked:\n\n" + decision.spec.body.trim() + "\n\n" + deciderLabel(answer.decider) + " answered: " + answer.words + "\n"
}

export const withDecisions = (body: string, decisions: ReadonlyArray<TaskRecord>): string => {
  const notes = decisions.filter((decision) => decision.spec.kind === "decision").map(decisionNote).join("")
  return notes === "" ? body : body.trimEnd() + notes
}

export const readAnsweredDependencies = (root: string, record: TaskRecord): Effect.Effect<ReadonlyArray<TaskRecord>, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.forEach(record.spec.dependsOn, (id) =>
    Effect.gen(function*() {
      const file = backlogPaths(root).taskFile("closed", id)
      const text = yield* readIfPresent(file)
      return text === null ? [] : [yield* parseTaskFile(file, "closed", text)]
    })).pipe(Effect.map((found) => found.flat().filter((dependency) => decisionAnswer(dependency) !== null)))
