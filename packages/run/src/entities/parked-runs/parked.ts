import { Array as Arr, Effect, FileSystem } from "effect"
import type { AskOption, OpenQuestion } from "../review-gate/index"
import { openReviewQuestions } from "../attention/index"
import { answerDecision, findTask, grabIn, ranClosing, type Rewrite, rewriteNew, rewriteTaken, taskBranch, BacklogError, platformFailure, publishOnce, takenGrab, type Hold, type HoldQuestion, isHeld, isDeciderAnswer, openQuestions, type Parked, type CaptainAnswer, type DeciderAnswer, type ParkedAnswer, type ParkedQuestion, parseTaskFile, type TaskFileError, type TaskRecord, renderTaskFile } from "../backlog/index"

// An answer handed to an asking that ended went into the run, so only one never handed out or handed to this asking still answers it.
const answersAsking = (answer: ParkedAnswer, asking: string | null): boolean => answer.relayedTo === null || answer.relayedTo === asking

const parkedQuestions = (
  open: Arr.NonEmptyReadonlyArray<OpenQuestion>,
  prior: ReadonlyArray<ParkedQuestion>,
  asking: string | null,
  askedOf: (question: OpenQuestion) => string
): Parked["questions"] => {
  const stillAsked = (known: ParkedQuestion, question: OpenQuestion) =>
    known.id === question.id && known.text === question.text && (known.asked === "" || question.asked === undefined || known.asked === askedOf(question)) &&
    (known.answer === null || answersAsking(known.answer, asking))
  const kept = prior.filter((known) => known.answer !== null && answersAsking(known.answer, asking) && !open.some((question) => question.id === known.id))
  return Arr.appendAll(
    Arr.map(open, (question): ParkedQuestion =>
      prior.find((known) => stillAsked(known, question)) ??
      { id: question.id, text: question.text, asked: askedOf(question), blocks: question.blocks ?? true, answer: null }),
    kept
  )
}

const sameQuestions = (left: ReadonlyArray<ParkedQuestion>, right: ReadonlyArray<ParkedQuestion>): boolean =>
  left.length === right.length && left.every((question, index) => question === right[index])

export interface LiveAsking {
  readonly asked: string
  readonly questions: Arr.NonEmptyReadonlyArray<OpenQuestion & { readonly options?: ReadonlyArray<AskOption> }>
}

// The live run keeps its claim, so its questions sit on the started task and orc backlog answer reaches them there.
export const askStartedTask = (
  root: string,
  id: string,
  asking: LiveAsking
): Effect.Effect<boolean, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  rewriteTaken(root, id, (fresh): Effect.Effect<Rewrite<boolean>, BacklogError, FileSystem.FileSystem> =>
    Effect.gen(function*() {
      if (fresh.state.kind !== "started") {
        return yield* new BacklogError({ detail: id + " is " + fresh.state.kind + ", and only a started task asks" })
      }
      const known = fresh.parked?.questions ?? []
      const questions = parkedQuestions(asking.questions, known, asking.asked, (question) => question.asked ?? asking.asked)
      if (sameQuestions(questions, known)) {
        return { kind: "keep", result: false } as const
      }
      const optionsOf = (question: ParkedQuestion) => asking.questions.find((live) => live.id === question.id)?.options
      const waiting = questions.filter((question) => question.answer === null)
      yield* openReviewQuestions(root, id, waiting.map((question) => {
        const options = optionsOf(question)
        return options === undefined ? question : { ...question, options }
      }))
      const parked: Parked = { ...fresh.parked, branch: fresh.parked?.branch ?? taskBranch(id), questions }
      return { kind: "write", record: { ...fresh, parked }, result: true } as const
    }))

// The resumed run gets every answer as --answer, so each is handed to the asking it answers.
export const handAnswersToResume = (record: TaskRecord): TaskRecord =>
  record.parked === null
    ? record
    : {
      ...record,
      parked: {
        ...record.parked,
        questions: Arr.map(record.parked.questions, (question) =>
          question.answer === null || question.answer.relayedTo !== null ? question : { ...question, answer: { ...question.answer, relayedTo: question.asked } }
        )
      }
    }

export const answersFor = (record: TaskRecord, asking: LiveAsking): ReadonlyArray<ParkedQuestion & { readonly answer: ParkedAnswer }> =>
  (record.parked?.questions ?? []).flatMap((question) =>
    question.answer !== null && answersAsking(question.answer, asking.asked) &&
    asking.questions.some((open) => open.id === question.id && (open.asked === undefined || open.asked === question.asked))
      ? [{ ...question, answer: question.answer }]
      : []
  )

// rename(2) takes the taken file at most once, so of two beats parking one run exactly one moves it back to new.
export const parkStartedTask = (
  root: string,
  id: string,
  branch: string,
  open: Arr.NonEmptyReadonlyArray<OpenQuestion>,
  at: string,
  run?: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* takenGrab(root, id, Effect.fail(new BacklogError({ detail: id + " was parked or closed by another command" })))
    const park = Effect.gen(function*() {
      const text = yield* read
      const record = yield* parseTaskFile(file, "taken", text)
      if (record.state.kind !== "started") {
        return yield* new BacklogError({ detail: id + " is " + record.state.kind + ", and only a started task parks" })
      }
      const lastAsking = open.find((question) => question.asked !== undefined)?.asked ?? null
      const questions = parkedQuestions(open, record.parked?.questions ?? [], lastAsking, (question) => question.asked ?? at)
      yield* openReviewQuestions(root, id, questions.filter((question) => question.answer === null))
      const sentPr = record.parked?.origin?.pr
      const origin = run === undefined ? record.parked?.origin : { machine: record.state.claim.machine, run, ...(sentPr === undefined ? {} : { pr: sentPr }) }
      const parked: TaskRecord = { ...record, parked: { branch, questions, ...(origin === undefined ? {} : { origin }) }, state: { kind: "new" } }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(parked)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return parked
    })
    const parked = yield* park.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return parked
  })

export type AnswerOutcome =
  | { readonly kind: "hold"; readonly hold: Hold }
  | { readonly kind: "decision" }
  | { readonly kind: "held question"; readonly question: string; readonly open: ReadonlyArray<HoldQuestion> }
  | { readonly kind: "question"; readonly question: string; readonly branch: string; readonly live: boolean; readonly open: ReadonlyArray<ParkedQuestion> }

const unanswered = <Q extends { readonly answer: { readonly words: string; readonly at: string } | null }>(questions: ReadonlyArray<Q>): ReadonlyArray<Q> => questions.filter((question) => question.answer === null)

const answerOneOf = <Q extends { readonly id: string; readonly answer: { readonly words: string; readonly at: string } | null }>(
  id: string,
  words: string,
  at: string,
  questions: ReadonlyArray<Q>,
  waits: "parked" | "held",
  fresh: TaskRecord,
  overturns: (answer: NonNullable<Q["answer"]>) => boolean = () => false
): Effect.Effect<{ readonly asked: Q; readonly answer: { readonly words: string; readonly at: string } }, BacklogError> => {
  const open = unanswered(questions)
  const cut = words.indexOf("=")
  const question = cut === -1 ? "" : words.slice(0, cut)
  const text = cut === -1 ? "" : words.slice(cut + 1)
  const asked = questions.find((candidate) => candidate.id === question)
  if (asked === undefined || text.trim() === "") {
    return Effect.fail(new BacklogError({ detail: id + " is " + waits + " for the captain's answer to " + open.map((candidate) => candidate.id).join(", ") + ", so answer one as <question-id>=<text>" }))
  }
  if (asked.answer !== null && !overturns(asked.answer)) {
    return Effect.fail(new BacklogError({ detail: id + " already has an answer to " + question + ": " + asked.answer.words }))
  }
  if (fresh.state.kind !== "new" && !(waits === "parked" && fresh.state.kind === "started")) {
    return Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" }))
  }
  return Effect.succeed({ asked, answer: { words: text, at } })
}

export type AnswerBy = "captain" | "decider" | "asked-back"

// Only the captain has the last word, so a captain's answer replaces a decider's and nothing replaces a captain's.
const overturnedBy = (by: AnswerBy) => (answer: ParkedAnswer): boolean => by === "captain" && isDeciderAnswer(answer)

const givenAnswer = (answer: { readonly words: string; readonly at: string }, by: AnswerBy, before: ParkedAnswer | null): ParkedAnswer => {
  if (by !== "captain") {
    return { ...answer, relayedTo: null, by }
  }
  return before !== null && isDeciderAnswer(before) ? { ...answer, relayedTo: null, overturned: before } : { ...answer, relayedTo: null }
}

const answerQuestionOn = (id: string, words: string, at: string, fresh: TaskRecord & { readonly parked: Parked }, by: AnswerBy): Effect.Effect<Rewrite<AnswerOutcome>, BacklogError> => {
  if (fresh.state.kind === "closed") {
    return Effect.fail(new BacklogError({ detail: id + " is closed, so the answers its run took stand" }))
  }
  const overturns = overturnedBy(by)
  if (openQuestions(fresh).length === 0 && !fresh.parked.questions.some((question) => question.answer !== null && overturns(question.answer))) {
    return Effect.fail(new BacklogError({ detail: id + " is not parked: its questions were answered" }))
  }
  return answerOneOf(id, words, at, fresh.parked.questions, "parked", fresh, overturns).pipe(Effect.map(({ asked, answer }) => {
    const questions = Arr.map(fresh.parked.questions, (candidate): ParkedQuestion => candidate === asked ? { ...asked, answer: givenAnswer(answer, by, asked.answer) } : candidate)
    const record: TaskRecord = { ...fresh, parked: { ...fresh.parked, questions } }
    return { kind: "write", record, result: { kind: "question", question: asked.id, branch: fresh.parked.branch, live: fresh.state.kind === "started", open: openQuestions(record) } }
  }))
}

// The released run reads only hold.answer, so the last answer writes every question's words into it.
const releasedWords = (questions: ReadonlyArray<HoldQuestion>): string =>
  questions.map((question) => question.text + ": " + (question.answer?.words ?? "")).join("\n")

export type ExpectedDecision =
  | { readonly kind: "held"; readonly generation: number }
  | { readonly kind: "parked" }

const heldGenerationOf = (hold: Hold): number => hold.history?.length ?? 0

const staleHold = (id: string, fresh: TaskRecord & { readonly hold: Hold }, expected: number | undefined): BacklogError | null =>
  expected !== undefined && heldGenerationOf(fresh.hold) !== expected
    ? new BacklogError({ detail: id + " was reheld while orc read it, so run the command again" })
    : null

const answerHeldQuestionOn = (id: string, words: string, at: string, fresh: TaskRecord & { readonly hold: Hold }): Effect.Effect<Rewrite<AnswerOutcome>, BacklogError> => {
  return answerOneOf(id, words, at, fresh.hold.questions, "held", fresh).pipe(Effect.map(({ asked, answer }) => {
    const questions = fresh.hold.questions.map((candidate): HoldQuestion => candidate === asked ? { ...asked, answer } : candidate)
    const open = unanswered(questions)
    const hold: Hold = { ...fresh.hold, questions, answer: open.length === 0 ? { words: releasedWords(questions), at } : null }
    return { kind: "write", record: { ...fresh, hold }, result: { kind: "held question", question: asked.id, open } }
  }))
}

const answerOn = (id: string, words: string, at: string, expected: ExpectedDecision | undefined, by: AnswerBy) => (fresh: TaskRecord): Effect.Effect<Rewrite<AnswerOutcome>, BacklogError> => {
  if (fresh.parked !== null) {
    if (expected !== undefined && expected.kind !== "parked") {
      return Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" }))
    }
    return answerQuestionOn(id, words, at, { ...fresh, parked: fresh.parked }, by)
  }
  if (by !== "captain") {
    return Effect.fail(new BacklogError({ detail: id + " is not parked, and the decider answers only a parked question" }))
  }
  if (expected !== undefined && expected.kind !== "held") {
    return Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" }))
  }
  if (!isHeld(fresh)) {
    return Effect.fail(new BacklogError({ detail: id + " is not held" + (fresh.hold?.answer == null ? "" : ": its hold was answered") }))
  }
  const stale = staleHold(id, fresh, expected?.kind === "held" ? expected.generation : undefined)
  if (stale !== null) {
    return Effect.fail(stale)
  }
  if (fresh.hold.questions.length > 0) {
    return answerHeldQuestionOn(id, words, at, fresh)
  }
  if (fresh.state.kind !== "new") {
    return Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" }))
  }
  const answered: Hold = { ...fresh.hold, answer: { words, at } }
  return Effect.succeed({ kind: "write", record: { ...fresh, hold: answered }, result: { kind: "hold", hold: answered } })
}

const relayTakenQuestions = (
  root: string,
  id: string,
  map: (questions: Arr.NonEmptyReadonlyArray<ParkedQuestion>) => Arr.NonEmptyReadonlyArray<ParkedQuestion>
): Effect.Effect<void, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  rewriteTaken(root, id, (fresh): Effect.Effect<Rewrite<void>, BacklogError> => {
    if (fresh.state.kind !== "started" || fresh.parked === null) {
      return Effect.succeed({ kind: "keep", result: undefined })
    }
    const questions = map(fresh.parked.questions)
    if (sameQuestions(questions, fresh.parked.questions)) {
      return Effect.succeed({ kind: "keep", result: undefined })
    }
    return Effect.succeed({ kind: "write", record: { ...fresh, parked: { ...fresh.parked, questions } }, result: undefined })
  })

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
  origin: NonNullable<Parked["origin"]>
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { fs, paths, file, grabbed, putBack, read } = yield* grabIn(root, "closed", id, Effect.fail(new BacklogError({ detail: id + " moved while orc read it, so run the command again" })))
    const send = Effect.gen(function*() {
      const record = yield* parseTaskFile(file, "closed", yield* read)
      const ran = ranClosing(record)
      if (ran === null) {
        return yield* new BacklogError({ detail: id + " closed without a run, so it has no branch to send back" })
      }
      const parked: Parked = { branch: taskBranch(id), questions: [sendBackQuestion(sendBackQuestionId, words, at)], origin: ran.pr === null ? origin : { ...origin, pr: ran.pr } }
      const sent: TaskRecord = { ...record, parked, state: { kind: "new" } }
      if (!(yield* publishOnce(paths.folder("new"), id + ".md", renderTaskFile(sent)))) {
        return yield* new BacklogError({ detail: "new/ already holds " + id })
      }
      return sent
    })
    const sent = yield* send.pipe(Effect.catch((error) => putBack.pipe(Effect.andThen(Effect.fail(error)))))
    yield* fs.remove(grabbed).pipe(Effect.mapError(platformFailure("remove " + grabbed)))
    return sent
  })
export const markAnswersRelayed = (
  root: string,
  id: string,
  asking: string,
  relayed: ReadonlyArray<{ readonly id: string; readonly asked: string; readonly words: string }>
): Effect.Effect<void, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  relayTakenQuestions(root, id, (prior) =>
    Arr.map(prior, (question): ParkedQuestion => {
      if (question.answer === null) {
        return question
      }
      const entry = relayed.find((candidate) => candidate.id === question.id && candidate.asked === question.asked)
      if (entry === undefined) {
        return question
      }
      if (question.answer.words === entry.words && question.answer.relayedTo === null) {
        return { ...question, answer: { ...question.answer, relayedTo: asking } }
      }
      if (!isDeciderAnswer(question.answer) && question.answer.overturned !== undefined && question.answer.overturned.relayedTo === null && question.answer.overturned.words === entry.words) {
        return { ...question, answer: { ...question.answer, overturned: { ...question.answer.overturned, relayedTo: asking } } }
      }
      return question
    }))

type Corrected = ParkedQuestion & { readonly answer: CaptainAnswer & { readonly overturned: DeciderAnswer & { readonly relayedTo: string } } }

const isDueCorrection = (question: ParkedQuestion): question is Corrected => {
  const answer = question.answer
  return answer !== null && !isDeciderAnswer(answer) && answer.relayedTo === null && answer.overturned !== undefined && answer.overturned.relayedTo !== null
}

// Only an overturned answer the run already took needs a correction, because one it never took is replaced in the relay itself.
export const correctionsDue = (record: TaskRecord): ReadonlyArray<Corrected> =>
  record.state.kind === "started" ? (record.parked?.questions ?? []).flatMap((question) => isDueCorrection(question) ? [question] : []) : []

export const markCorrectionsRelayed = (
  root: string,
  id: string,
  corrected: ReadonlyArray<{ readonly id: string; readonly asked: string }>
): Effect.Effect<void, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  relayTakenQuestions(root, id, (prior) =>
    Arr.map(prior, (question): ParkedQuestion =>
      isDueCorrection(question) && corrected.some((entry) => entry.id === question.id && entry.asked === question.asked)
        ? { ...question, answer: { ...question.answer, relayedTo: question.answer.overturned.relayedTo } }
        : question
    ))
export const answerTask = (
  root: string,
  id: string,
  words: string,
  at: string,
  expected?: ExpectedDecision,
  by: AnswerBy = "captain"
): Effect.Effect<AnswerOutcome, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    if (record.spec.kind === "decision") {
      if (record.state.kind === "closed") {
        return yield* new BacklogError({ detail: id + " is a decision already closed " + record.state.closing.outcome + ": " + record.state.closing.reason })
      }
      yield* answerDecision(root, id, words, at)
      return { kind: "decision" } as const
    }
    const decide = answerOn(id, words, at, expected, by)
    if (record.state.kind === "started" && record.parked !== null) {
      return yield* rewriteTaken(root, id, decide)
    }
    if (record.state.kind !== "new") {
      const refused = yield* decide(record)
      return refused.result
    }
    return yield* rewriteNew(root, id, decide)
  })

