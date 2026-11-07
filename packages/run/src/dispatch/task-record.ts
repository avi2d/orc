import { Array as Arr, Data, Effect, Schema } from "effect"
import { claimOf, startedOf, TaskFields } from "@tui-dash/schema"
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

// relayedTo names the asking the answer was handed to, and null means no run has it yet.
export interface ParkedAnswer extends Answer {
  readonly relayedTo: string | null
}

export interface ParkedQuestion {
  readonly id: string
  readonly text: string
  readonly asked: string
  readonly answer: ParkedAnswer | null
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
  | { readonly outcome: "done" | "failed" | "stopped"; readonly started: Started; readonly reason: string; readonly pr: string | null; readonly report: string | null }

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
  asked_at: Schema.optional(Schema.String),
  relayed_to: Schema.optional(Schema.String),
  used: Schema.optional(Schema.Boolean)
})

const Frontmatter = Schema.Struct({
  ...TaskFields.fields,
  kind: Schema.optional(Schema.String),
  internal: Schema.optional(Schema.Boolean),
  hold_reason: Schema.optional(Schema.String),
  hold_until: Schema.optional(Schema.String),
  hold_questions: Schema.optional(Schema.Array(QuestionFront)),
  answer: Schema.optional(Schema.String),
  answered_at: Schema.optional(Schema.String),
  parked_branch: Schema.optional(Schema.String),
  parked_questions: Schema.optional(Schema.Array(QuestionFront)),
  pr: Schema.optional(Schema.String),
  report: Schema.optional(Schema.String),
  posted_at: Schema.optional(Schema.String)
})
type Frontmatter = typeof Frontmatter.Type

export const fence = "---"

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

const checkedQuestions = <Q>(fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string, toQuestion: (question: typeof QuestionFront.Type, answer: Answer | null) => Q): Array<Q> | string => {
  const questions: Array<Q> = []
  for (const question of fronts) {
    const answer = answerOf(question)
    if (typeof answer === "string") {
      return "the " + what + " question " + question.id + " names its answer with no words or no time"
    }
    questions.push(toQuestion(question, answer))
  }
  return questions
}

const questionsOf = (fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string): Array<ParkedQuestion> | string =>
  checkedQuestions(fronts, what, (question, answer) => ({
    id: question.id,
    text: question.text,
    asked: question.asked_at ?? "",
    answer: answer === null ? null : { ...answer, relayedTo: question.relayed_to ?? (question.used === true ? (question.asked_at ?? "") : null) }
  }))

const holdQuestionsOf = (fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string): Array<HoldQuestion> | string =>
  checkedQuestions(fronts, what, (question, answer) => ({ id: question.id, text: question.text, answer }))

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

