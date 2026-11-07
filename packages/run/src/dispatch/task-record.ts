import { Array as Arr, Data, Effect, Schema } from "effect"
import { isTaskKind, type TaskKind, unknownKind } from "../task-kind"

export const taskFolders = ["new", "taken", "closed"] as const
export type TaskFolder = typeof taskFolders[number]

export interface TaskSpec {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly kind: TaskKind
  readonly internal: boolean
  readonly machine: string | null
  readonly dependsOn: ReadonlyArray<string>
  readonly created: string
  readonly body: string
}

export interface Claim {
  readonly beat: string
  readonly machine: string
  readonly account: string
  readonly takenAt: string
}

export interface Started {
  readonly at: string
  readonly log: string
}

interface Answer {
  readonly words: string
  readonly at: string
}

export interface ParkedQuestion {
  readonly id: string
  readonly text: string
  readonly answer: Answer | null
  readonly used: boolean
}

export interface HoldQuestion {
  readonly id: string
  readonly text: string
  readonly answer: Answer | null
}

export interface Hold {
  readonly reason: string
  readonly until: string | null
  readonly questions: ReadonlyArray<HoldQuestion>
  readonly answer: Answer | null
}

export interface Parked {
  readonly branch: string
  readonly questions: Arr.NonEmptyReadonlyArray<ParkedQuestion>
}

type Closing =
  | { readonly outcome: "start-failed"; readonly reason: string }
  | { readonly outcome: "done" | "failed"; readonly started: Started; readonly reason: string; readonly pr: string | null; readonly report: string | null }

type TaskState =
  | { readonly kind: "new" }
  | { readonly kind: "taken"; readonly claim: Claim | null }
  | { readonly kind: "started"; readonly claim: Claim; readonly started: Started }
  | { readonly kind: "closed"; readonly claim: Claim; readonly closing: Closing; readonly closedAt: string; readonly postedAt: string | null }

export interface TaskRecord {
  readonly spec: TaskSpec
  readonly hold: Hold | null
  readonly parked: Parked | null
  readonly state: TaskState
}

type HeldRecord = TaskRecord & { readonly hold: Hold & { readonly answer: null } }

export const isHeld = (record: TaskRecord): record is HeldRecord => record.hold !== null && record.hold.answer === null

const heldReason = (task: TaskRecord): string | null =>
  isHeld(task) ? "held for the captain: " + task.hold.reason + (task.hold.until === null ? "" : ", until " + task.hold.until) : null

export const openQuestions = (task: TaskRecord): ReadonlyArray<ParkedQuestion> =>
  task.parked?.questions.filter((question) => question.answer === null) ?? []

const parkedReason = (task: TaskRecord): string | null => {
  const open = openQuestions(task)
  return task.parked === null || open.length === 0
    ? null
    : "parked on " + task.parked.branch + " for the captain's answer to " + open.map((question) => question.id).join(", ")
}

export const captainWait = (task: TaskRecord): string | null => heldReason(task) ?? parkedReason(task)

const datePattern = /^\d{4}-\d{2}-\d{2}$/

export const isCalendarDate = (text: string): boolean =>
  datePattern.test(text) && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text

export class TaskFileError extends Data.TaggedError("TaskFileError")<{
  readonly file: string
  readonly detail: string
}> {}

const QuestionFront = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  answer: Schema.optional(Schema.String),
  answered_at: Schema.optional(Schema.String),
  used: Schema.optional(Schema.Boolean)
})

const Frontmatter = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  kind: Schema.optional(Schema.String),
  internal: Schema.optional(Schema.Boolean),
  machine: Schema.NullOr(Schema.String),
  depends_on: Schema.Array(Schema.String),
  created: Schema.String,
  hold_reason: Schema.optional(Schema.String),
  hold_until: Schema.optional(Schema.String),
  hold_questions: Schema.optional(Schema.Array(QuestionFront)),
  answer: Schema.optional(Schema.String),
  answered_at: Schema.optional(Schema.String),
  parked_branch: Schema.optional(Schema.String),
  parked_questions: Schema.optional(Schema.Array(QuestionFront)),
  beat: Schema.optional(Schema.String),
  taken_for: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  taken_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  start_log: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["done", "failed", "start-failed"])),
  closed_at: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  pr: Schema.optional(Schema.String),
  report: Schema.optional(Schema.String),
  posted_at: Schema.optional(Schema.String)
})
type Frontmatter = typeof Frontmatter.Type

const fence = "---"

const claimOf = (front: Frontmatter): Claim | null =>
  front.beat === undefined || front.taken_for === undefined || front.account === undefined || front.taken_at === undefined
    ? null
    : { beat: front.beat, machine: front.taken_for, account: front.account, takenAt: front.taken_at }

const startedOf = (front: Frontmatter): Started | null =>
  front.started_at === undefined ? null : { at: front.started_at, log: front.start_log ?? "" }

const closingOf = (front: Frontmatter, started: Started | null): Closing | null => {
  const reason = front.reason ?? ""
  if (front.outcome === "start-failed") {
    return { outcome: "start-failed", reason }
  }
  return front.outcome === undefined || started === null ? null : { outcome: front.outcome, started, reason, pr: front.pr ?? null, report: front.report ?? null }
}

const answerOf = (front: { readonly answer?: string | undefined; readonly answered_at?: string | undefined }): Answer | null | string => {
  if (front.answer === undefined && front.answered_at === undefined) {
    return null
  }
  if (front.answer === undefined || front.answered_at === undefined || Number.isNaN(Date.parse(front.answered_at))) {
    return "an answer names no words or no time"
  }
  return { words: front.answer, at: front.answered_at }
}

const questionsOf = (fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string): Array<ParkedQuestion> | string => {
  const questions: Array<ParkedQuestion> = []
  for (const question of fronts) {
    const answer = answerOf(question)
    if (typeof answer === "string") {
      return "the " + what + " question " + question.id + " names its answer with no words or no time"
    }
    questions.push({ id: question.id, text: question.text, answer, used: question.used ?? false })
  }
  return questions
}

const holdQuestionsOf = (fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string): Array<HoldQuestion> | string => {
  const questions: Array<HoldQuestion> = []
  for (const question of fronts) {
    const answer = answerOf(question)
    if (typeof answer === "string") {
      return "the " + what + " question " + question.id + " names its answer with no words or no time"
    }
    questions.push({ id: question.id, text: question.text, answer })
  }
  return questions
}

const parkedOf = (front: Frontmatter): Parked | null | string => {
  if (front.parked_branch === undefined && front.parked_questions === undefined) {
    return null
  }
  if (front.parked_branch === undefined || front.parked_branch === "") {
    return "a parked task names no branch"
  }
  const questions = questionsOf(front.parked_questions ?? [], "parked")
  if (typeof questions === "string") {
    return questions
  }
  return Arr.isReadonlyArrayNonEmpty(questions) ? { branch: front.parked_branch, questions } : "a parked task names no question"
}

const holdOf = (front: Frontmatter): Hold | null | string => {
  const answer = answerOf(front)
  if (typeof answer === "string") {
    return answer
  }
  if (front.hold_reason === undefined) {
    return front.hold_until === undefined && front.hold_questions === undefined && answer === null ? null : "a hold names no reason"
  }
  if (front.hold_reason.trim() === "") {
    return "a hold names no reason"
  }
  if (front.hold_until !== undefined && !isCalendarDate(front.hold_until)) {
    return "the hold_until " + front.hold_until + " is no YYYY-MM-DD date"
  }
  const questions = holdQuestionsOf(front.hold_questions ?? [], "held")
  if (typeof questions === "string") {
    return questions
  }
  if (answer === null && questions.length > 0 && questions.every((question) => question.answer !== null)) {
    return "a hold answers every question and names no answer"
  }
  return { reason: front.hold_reason, until: front.hold_until ?? null, questions, answer }
}

const stateOf = (folder: TaskFolder, front: Frontmatter): TaskState | string => {
  if (folder === "new") {
    return { kind: "new" }
  }
  const claim = claimOf(front)
  const started = startedOf(front)
  if (folder === "taken") {
    if (started === null) {
      return { kind: "taken", claim }
    }
    return claim === null ? "a started task names no claim" : { kind: "started", claim, started }
  }
  const closing = closingOf(front, started)
  if (claim === null || closing === null || front.closed_at === undefined) {
    return "a closed task names no claim, outcome or close time"
  }
  return { kind: "closed", claim, closing, closedAt: front.closed_at, postedAt: front.posted_at ?? null }
}

const splitFrontmatter = (text: string): { readonly head: string; readonly body: string } | null => {
  if (!text.startsWith(fence + "\n")) {
    return null
  }
  const end = text.indexOf("\n" + fence + "\n", fence.length)
  if (end === -1) {
    return null
  }
  return { head: text.slice(fence.length + 1, end + 1), body: text.slice(end + fence.length + 2) }
}

export const parseTaskFile = (file: string, folder: TaskFolder, text: string): Effect.Effect<TaskRecord, TaskFileError> =>
  Effect.gen(function*() {
    const parts = splitFrontmatter(text)
    if (parts === null) {
      return yield* new TaskFileError({ file, detail: "the task file opens with no --- frontmatter" })
    }
    const raw: unknown = yield* Effect.try({
      try: () => Bun.YAML.parse(parts.head),
      catch: () => new TaskFileError({ file, detail: "the frontmatter is no YAML orc can read" })
    })
    const front = yield* Schema.decodeUnknownEffect(Frontmatter)(raw).pipe(
      Effect.mapError((error) => new TaskFileError({ file, detail: error.message }))
    )
    const kind = front.kind ?? "ship"
    if (!isTaskKind(kind)) {
      return yield* new TaskFileError({ file, detail: unknownKind(kind) })
    }
    const stem = file.split("/").at(-1)?.replace(/\.md$/, "")
    if (front.id !== stem) {
      return yield* new TaskFileError({ file, detail: "the frontmatter id " + front.id + " is not the file " + (stem ?? file) })
    }
    const state = stateOf(folder, front)
    if (typeof state === "string") {
      return yield* new TaskFileError({ file, detail: state })
    }
    const hold = holdOf(front)
    if (typeof hold === "string") {
      return yield* new TaskFileError({ file, detail: hold })
    }
    if (hold !== null && hold.answer === null && (state.kind === "started" || state.kind === "closed")) {
      return yield* new TaskFileError({ file, detail: "a " + state.kind + " task carries an unanswered hold" })
    }
    const parked = parkedOf(front)
    if (typeof parked === "string") {
      return yield* new TaskFileError({ file, detail: parked })
    }
    if (parked?.questions.some((question) => question.answer === null) === true && state.kind === "closed") {
      return yield* new TaskFileError({ file, detail: "a closed task carries an unanswered parked question" })
    }
    return {
      spec: {
        id: front.id,
        title: front.title,
        project: front.project,
        kind,
        internal: front.internal ?? false,
        machine: front.machine,
        dependsOn: front.depends_on,
        created: front.created,
        body: parts.body
      },
      hold,
      parked,
      state
    }
  })

const field = (key: string, value: unknown): string => key + ": " + JSON.stringify(value)

const claimFields = (claim: Claim | null): ReadonlyArray<string> =>
  claim === null
    ? []
    : [field("beat", claim.beat), field("taken_for", claim.machine), field("account", claim.account), field("taken_at", claim.takenAt)]

const startedFields = (started: Started): ReadonlyArray<string> => [field("started_at", started.at), field("start_log", started.log)]

const questionFronts = (questions: ReadonlyArray<ParkedQuestion>) =>
  questions.map((question) => ({
    id: question.id,
    text: question.text,
    ...(question.answer === null ? {} : { answer: question.answer.words, answered_at: question.answer.at }),
    ...(question.used ? { used: true } : {})
  }))

const holdQuestionFronts = (questions: ReadonlyArray<HoldQuestion>) =>
  questions.map((question) => ({
    id: question.id,
    text: question.text,
    ...(question.answer === null ? {} : { answer: question.answer.words, answered_at: question.answer.at })
  }))

const holdFields = (hold: Hold | null): ReadonlyArray<string> =>
  hold === null
    ? []
    : [
      field("hold_reason", hold.reason),
      ...(hold.until === null ? [] : [field("hold_until", hold.until)]),
      ...(hold.questions.length === 0 ? [] : [field("hold_questions", holdQuestionFronts(hold.questions))]),
      ...(hold.answer === null ? [] : [field("answer", hold.answer.words), field("answered_at", hold.answer.at)])
    ]

const parkedFields = (parked: Parked | null): ReadonlyArray<string> =>
  parked === null
    ? []
    : [field("parked_branch", parked.branch), field("parked_questions", questionFronts(parked.questions))]

const stateFields = (state: TaskState): ReadonlyArray<string> => {
  switch (state.kind) {
    case "new": {
      return []
    }
    case "taken": {
      return claimFields(state.claim)
    }
    case "started": {
      return [...claimFields(state.claim), ...startedFields(state.started)]
    }
    case "closed": {
      const ran = state.closing.outcome === "start-failed"
        ? { started: [], pr: [] }
        : {
          started: startedFields(state.closing.started),
          pr: [
            ...(state.closing.pr === null ? [] : [field("pr", state.closing.pr)]),
            ...(state.closing.report === null ? [] : [field("report", state.closing.report)])
          ]
        }
      return [
        ...claimFields(state.claim),
        ...ran.started,
        field("outcome", state.closing.outcome),
        field("closed_at", state.closedAt),
        field("reason", state.closing.reason),
        ...ran.pr,
        ...(state.postedAt === null ? [] : [field("posted_at", state.postedAt)])
      ]
    }
  }
}

export const renderTaskFile = (record: TaskRecord): string =>
  [
    fence,
    field("id", record.spec.id),
    field("title", record.spec.title),
    field("project", record.spec.project),
    field("kind", record.spec.kind),
    ...(record.spec.internal ? [field("internal", true)] : []),
    field("machine", record.spec.machine),
    field("depends_on", record.spec.dependsOn),
    field("created", record.spec.created),
    ...holdFields(record.hold),
    ...parkedFields(record.parked),
    ...stateFields(record.state),
    fence,
    record.spec.body
  ].join("\n")
