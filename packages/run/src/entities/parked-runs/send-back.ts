import { Effect, FileSystem } from "effect"
import { grabIn, ranClosing, rewriteNew, taskBranch, BacklogError, platformFailure, publishOnce, type Parked, type ParkedQuestion, parseTaskFile, type TaskFileError, type TaskRecord, renderTaskFile } from "../backlog/index"

const sendBackQuestionId = "send-back"

export const isSendBackQuestion = (question: string): boolean =>
  question === sendBackQuestionId || question.startsWith(sendBackQuestionId + "-")

const sendBackQuestion = (id: string, words: string, at: string): ParkedQuestion =>
  ({ id, text: "The captain sent the pull request back", asked: at, blocks: true, answer: { words, at, relayedTo: null } })

const notSentBack = (id: string, kind: string) =>
  new BacklogError({ detail: "orc backlog send-back refused: " + id + " is " + kind + ", and only a closed task goes back" })

export const addSendBackWords = (
  root: string,
  id: string,
  words: string,
  at: string
): Effect.Effect<NonNullable<Parked["origin"]>, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  rewriteNew(root, id, (fresh) => {
    const parked = fresh.parked
    if (parked === null || parked.origin === undefined || parked.branch !== taskBranch(id) || !parked.questions.every((question) => isSendBackQuestion(question.id))) {
      return Effect.fail(notSentBack(id, fresh.state.kind))
    }
    const question = sendBackQuestion(sendBackQuestionId + "-" + (parked.questions.length + 1).toString(), words, at)
    return Effect.succeed({ kind: "write", record: { ...fresh, parked: { ...parked, questions: [...parked.questions, question] } }, result: parked.origin })
  })

// link(2) publishes new/ at most once, so of two send-backs of one task exactly one moves it.
export const sendBackClosedTask = (
  root: string,
  id: string,
  words: string,
  at: string,
  origin: NonNullable<Parked["origin"]>,
  mergeRecord: "kept" | "cleared"
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "closed", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" })))
    const send = Effect.gen(function*() {
      const record = yield* parseTaskFile(file, "closed", yield* read)
      const ran = ranClosing(record)
      if (ran === null) {
        return yield* new BacklogError({ detail: id + " closed without a run, so it has no branch to send back" })
      }
      const parked: Parked = { branch: taskBranch(id), questions: [sendBackQuestion(sendBackQuestionId, words, at)], origin: ran.pr === null ? origin : { ...origin, pr: ran.pr }, at, sentBackAt: at }
      const { merge: _merge, ...unmerged } = record
      const sent: TaskRecord = { ...(mergeRecord === "kept" ? record : unmerged), parked, state: { kind: "new" } }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(sent)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return sent
    })
    const sent = yield* send.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return sent
  })
