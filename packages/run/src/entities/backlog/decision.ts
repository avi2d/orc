import { Effect, FileSystem } from "effect"
import { decisionAnswer, isHeld, parseTaskFile, type TaskFileError, type TaskRecord } from "./task-record"
import { answeredReason } from "./task-record-decision"
import { renderTaskFile } from "./task-record-render"
import { BacklogError, backlogPaths, newGrab, platformFailure, publishOnce, readIfPresent } from "./backlog-write"

export const decisionRefusal = (record: TaskRecord, verb: string): string | null =>
  record.spec.kind === "decision"
    ? record.spec.id + " is a decision, so it takes no " + verb + ": answer it with orc backlog answer " + record.spec.id + " or drop it with orc backlog close " + record.spec.id + " failed"
    : null

export const newTaskRefusal = (record: TaskRecord, id: string, verb: string, action: string): string | null =>
  decisionRefusal(record, verb) ?? (record.state.kind === "new" ? null : id + " is " + record.state.kind + ", and only a new task " + action)

const answeredRecord = (fresh: TaskRecord, words: string, at: string): TaskRecord => ({
  ...fresh,
  hold: isHeld(fresh) ? null : fresh.hold,
  state: { kind: "closed", claim: null, closing: { outcome: "done", reason: answeredReason, answer: { words, at } }, closedAt: at, postedAt: null }
})

// rename(2) takes the one task file at most once, so two answers never both close the decision.
export const answerDecision = (root: string, id: string, words: string, at: string): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* newGrab(root, id)
    const settle = Effect.gen(function*() {
      const fresh = yield* parseTaskFile(file, "new", yield* read)
      const answered = answeredRecord(fresh, words, at)
      if (!(yield* publishOnce(paths.folder("closed"), id + ".md", renderTaskFile(answered)))) {
        return yield* new BacklogError({ detail: id + " was closed by another command" })
      }
      return answered
    })
    const answered = yield* settle.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return answered
  })

const decisionNote = (decision: TaskRecord): string => {
  const answer = decisionAnswer(decision)
  return answer === null
    ? ""
    : "\n\nThe captain's decision " + decision.spec.id + " asked:\n\n" + decision.spec.body.trim() + "\n\nThe captain answered: " + answer.words + "\n"
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
