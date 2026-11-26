import { claimOf, startedOf, taskStateFields } from "@avi2dg/orc-schema"
import { Data, Effect, Schema } from "effect"
import { Decider } from "../../shared/lib/index"
import { type Answer, answerOf, decisionStateOf, type AnsweredClosing } from "./task-record-decision"
import { isTaskKind, type TaskKind, unknownKind } from "./task-kind"
import { deciderAnswerKinds, OverturnedFront, parkedAnswerOf } from "./task-record-answer"
import { ChoicesFront, choicesOf, type ParkedQuestion } from "./task-record-question"
import { fullPrUrl, isCalendarDate } from "./task-record-text"
import { MergeRecord } from "./task-record-merge"
import { type AnsweredHold, type HoldQuestion, migrateHold, StoredAnsweredHold } from "./task-record-hold"
import { closedWithUnansweredQuestion, heldWhileActive, priorPrOf, splitFrontmatter } from "./task-record-parts"

export { isDeciderAnswer } from "./task-record-answer"
export type { CaptainAnswer, DeciderAnswer, ParkedAnswer } from "./task-record-answer"
export type { ParkedQuestion } from "./task-record-question"
export type { HoldQuestion } from "./task-record-hold"

export const taskFolders = ["new", "taken", "closed"] as const
export type TaskFolder = typeof taskFolders[number]

const splitSources = ["intake", "run"] as const
export type SplitSource = typeof splitSources[number]

export interface SplitMark {
  readonly by: SplitSource
  readonly reason: string
}

export const taskPriorities = [0, 1, 2, 3, 4] as const
export type TaskPriority = typeof taskPriorities[number]

export const isTaskPriority = (value: number): value is TaskPriority => taskPriorities.some((priority) => priority === value)

export interface TaskSpec {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly kind: TaskKind
  readonly internal: boolean
  readonly machine: string | null
  readonly parent: string | null
  readonly split: SplitMark | null
  readonly dependsOn: ReadonlyArray<string>
  readonly priority: TaskPriority | null
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

export interface Hold {
  readonly reason: string
  readonly until: string | null
  readonly questions: ReadonlyArray<HoldQuestion>
  readonly answer: Answer | null
  readonly at: string | null
  readonly repeat?: boolean
  readonly history?: ReadonlyArray<AnsweredHold>
}

const ParkedOrigin = Schema.Struct({ machine: Schema.String.check(Schema.isNonEmpty()), run: Schema.String.check(Schema.isNonEmpty()), pr: Schema.optional(Schema.String) })

export interface Parked {
  readonly origin?: typeof ParkedOrigin.Type
  readonly at?: string
  readonly sentBackAt?: string
  readonly branch: string
  readonly questions: ReadonlyArray<ParkedQuestion>
}

export interface RanClosing {
  readonly outcome: "done" | "failed" | "stopped"
  readonly started: Started
  readonly reason: string
  readonly pr: string | null
  readonly report: string | null
}

interface LandedClosing {
  readonly outcome: "done"
  readonly reason: string
  readonly landedIn: string
}

export const landedClosing = (landedIn: string): LandedClosing =>
  ({ outcome: "done", reason: "work landed in " + landedIn, landedIn })

type Closing = { readonly outcome: "start-failed"; readonly reason: string } | RanClosing

type ClosedState = { readonly kind: "closed"; readonly closedAt: string; readonly postedAt: string | null } & (
  | { readonly claim: Claim; readonly closing: Closing }
  | { readonly claim: null; readonly closing: { readonly outcome: "dropped"; readonly reason: string } | AnsweredClosing | LandedClosing }
)

type TaskState =
  | { readonly kind: "new" }
  | { readonly kind: "taken"; readonly claim: Claim | null }
  | { readonly kind: "started"; readonly claim: Claim; readonly started: Started }
  | ClosedState

const CiRerun = Schema.Struct({ pr: Schema.String, runs: Schema.Array(Schema.String), at: Schema.String })
export type CiRerun = typeof CiRerun.Type
const Retry = Schema.Struct({ run: Schema.String.check(Schema.isNonEmpty()), at: Schema.String.check(Schema.isNonEmpty()) })
export const Rebase = Schema.Struct({ pr: Schema.String.check(Schema.isNonEmpty()), head: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)), at: Schema.String.check(Schema.isNonEmpty()) })
export type Rebase = typeof Rebase.Type

export interface TaskRecord {
  readonly ciReruns?: ReadonlyArray<CiRerun>
  readonly merge?: MergeRecord
  readonly spec: TaskSpec
  readonly hold: Hold | null
  readonly retry?: typeof Retry.Type
  readonly rebase?: Rebase
  readonly ciSentBack?: ReadonlyArray<string>
  readonly parked: Parked | null
  readonly priorPr?: string
  readonly state: TaskState
}

type HeldRecord = TaskRecord & { readonly hold: Hold & { readonly answer: null } }

export const isHeld = (record: TaskRecord): record is HeldRecord => record.hold !== null && record.hold.answer === null

export const openQuestions = (task: TaskRecord): ReadonlyArray<ParkedQuestion> =>
  task.parked?.questions.filter((question) => question.answer === null) ?? []

export const ranClosing = (task: TaskRecord): RanClosing | null =>
  task.state.kind === "closed" && task.state.claim !== null && task.state.closing.outcome !== "start-failed" ? task.state.closing : null

export const decisionAnswer = (task: TaskRecord): Answer | null =>
  task.state.kind === "closed" && task.state.claim === null && "answer" in task.state.closing ? task.state.closing.answer : null

export const taskLandedIn = (task: TaskRecord): string | null =>
  task.state.kind === "closed" && "landedIn" in task.state.closing ? task.state.closing.landedIn : null

export const taskPr = (task: TaskRecord): string | null => ranClosing(task)?.pr ?? null

export class TaskFileError extends Data.TaggedError("TaskFileError")<{
  readonly file: string
  readonly detail: string
}> {}

const QuestionFront = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  answer: Schema.optional(Schema.String),
  answered_at: Schema.optional(Schema.String),
  decider: Schema.optional(Decider),
  asked_at: Schema.optional(Schema.String),
  blocks: Schema.optional(Schema.Boolean),
  ...ChoicesFront,
  relayed_to: Schema.optional(Schema.String),
  used: Schema.optional(Schema.Boolean),
  answered_by: Schema.optional(Schema.Literals(deciderAnswerKinds)),
  overturned: Schema.optional(OverturnedFront),
  correction_queued: Schema.optional(Schema.Boolean),
  owner: Schema.optional(Schema.Literal("user"))
})

const Frontmatter = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  kind: Schema.optional(Schema.String),
  internal: Schema.optional(Schema.Boolean),
  machine: Schema.NullOr(Schema.String),
  parent: Schema.optional(Schema.String),
  split: Schema.optional(Schema.Struct({ by: Schema.Literals(splitSources), reason: Schema.String })),
  depends_on: Schema.Array(Schema.String),
  priority: Schema.optional(Schema.Literals(taskPriorities)),
  created: Schema.String,
  hold_reason: Schema.optional(Schema.String),
  hold_repeat: Schema.optional(Schema.Boolean),
  hold_until: Schema.optional(Schema.String),
  held_at: Schema.optional(Schema.String),
  hold_questions: Schema.optional(Schema.Array(QuestionFront)),
  hold_history: Schema.optional(Schema.Array(StoredAnsweredHold)),
  answer: Schema.optional(Schema.String),
  answered_at: Schema.optional(Schema.String),
  decider: Schema.optional(Decider),
  retry: Schema.optional(Retry),
  rebase: Schema.optional(Rebase),
  ci_sent_back: Schema.optional(Schema.Array(Schema.String)),
  parked_branch: Schema.optional(Schema.String),
  parked_origin: Schema.optional(ParkedOrigin),
  parked_at: Schema.optional(Schema.String),
  parked_sent_back_at: Schema.optional(Schema.String),
  parked_questions: Schema.optional(Schema.Array(QuestionFront)),
  ...taskStateFields,
  landed_in: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  pr: Schema.optional(Schema.String),
  report: Schema.optional(Schema.String),
  posted_at: Schema.optional(Schema.String),
  ci_reruns: Schema.optional(Schema.Array(CiRerun)),
  merge: Schema.optional(MergeRecord)
})
type Frontmatter = typeof Frontmatter.Type

export { fence } from "./task-record-parts"

const closingOf = (front: Frontmatter, started: Started | null): Closing | null => {
  const reason = front.reason ?? ""
  if (front.outcome === "start-failed") {
    return { outcome: "start-failed", reason }
  }
  return front.outcome === undefined || front.outcome === "dropped" || started === null ? null : { outcome: front.outcome, started, reason, pr: front.pr ?? null, report: front.report ?? null }
}

const checkedQuestions = <Q>(fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string, legacyDecider: (question: typeof QuestionFront.Type) => Decider, toQuestion: (question: typeof QuestionFront.Type, answer: Answer | null) => Q): Array<Q> | string => {
  const questions: Array<Q> = []
  for (const question of fronts) {
    const answer = answerOf(question, legacyDecider(question))
    if (typeof answer === "string") {
      return "the " + what + " question " + question.id + " names its answer with no words or no time"
    }
    questions.push(toQuestion(question, answer))
  }
  return questions
}

const legacyParkedDecider = (question: typeof QuestionFront.Type): Decider =>
  question.answered_by !== undefined || (question.id === "send-back" && question.text === "A CI check sent the pull request back") ? "agent" : "owner"

const questionsOf = (fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string): Array<ParkedQuestion> | string =>
  checkedQuestions(fronts, what, legacyParkedDecider, (question, answer) => ({
    id: question.id,
    text: question.text,
    asked: question.asked_at ?? "",
    blocks: question.blocks ?? true,
    ...choicesOf(question),
    answer: answer === null ? null : parkedAnswerOf(question, answer),
    ...(question.owner === undefined ? {} : { owner: question.owner })
  }))

const holdQuestionsOf = (fronts: ReadonlyArray<typeof QuestionFront.Type>, what: string): Array<HoldQuestion> | string =>
  checkedQuestions(fronts, what, () => "owner", (question, answer) => ({ id: question.id, text: question.text, answer }))

const parkedOf = (front: Frontmatter): Parked | null | string => {
  if (front.parked_branch === undefined && front.parked_questions === undefined && front.parked_origin === undefined) {
    return null
  }
  if (front.parked_branch === undefined || front.parked_branch === "") {
    return "a parked task names no branch"
  }
  const questions = questionsOf(front.parked_questions ?? [], "parked")
  if (typeof questions === "string") {
    return questions
  }
  return questions.length > 0 || ((front.retry !== undefined || front.rebase !== undefined) && front.parked_origin !== undefined)
    ? { branch: front.parked_branch, questions, ...(front.parked_origin === undefined ? {} : { origin: front.parked_origin }), ...(front.parked_at === undefined ? {} : { at: front.parked_at }), ...(front.parked_sent_back_at === undefined ? {} : { sentBackAt: front.parked_sent_back_at }) }
    : "a parked task names no question"
}

const holdOf = (front: Frontmatter): Hold | null | string => {
  const answer = answerOf(front, "owner")
  if (typeof answer === "string") {
    return answer
  }
  if (front.hold_reason === undefined) {
    return front.hold_until === undefined && front.held_at === undefined && front.hold_questions === undefined && front.hold_history === undefined && front.hold_repeat === undefined && answer === null ? null : "a hold names no reason"
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
  return { reason: front.hold_reason, until: front.hold_until ?? null, questions, answer, at: front.held_at ?? null, ...(front.hold_repeat === true ? { repeat: true } : {}), ...(front.hold_history === undefined ? {} : { history: front.hold_history.map(migrateHold) }) }
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
  if (front.landed_in !== undefined) {
    const landedIn = fullPrUrl(front.landed_in)
    return landedIn === null || claim !== null || started !== null || front.outcome !== "done" || front.closed_at === undefined
      ? "a task completed elsewhere needs a PR URL, a done outcome and a close time, with no claim or start time"
      : { kind: "closed", claim: null, closing: landedClosing(landedIn), closedAt: front.closed_at, postedAt: front.posted_at ?? null }
  }
  if (front.outcome === "dropped") {
    return front.closed_at === undefined
      ? "a dropped task names no close time"
      : { kind: "closed", claim: null, closing: { outcome: "dropped", reason: front.reason ?? "" }, closedAt: front.closed_at, postedAt: front.posted_at ?? null }
  }
  const closing = closingOf(front, started)
  if (claim === null || closing === null || front.closed_at === undefined) {
    return "a closed task names no claim, outcome or close time"
  }
  return { kind: "closed", claim, closing, closedAt: front.closed_at, postedAt: front.posted_at ?? null }
}

const unlessRefused = <A extends object | null>(file: string, value: A | string): Effect.Effect<A, TaskFileError> =>
  typeof value === "string" ? Effect.fail(new TaskFileError({ file, detail: value })) : Effect.succeed(value)

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
    const state = yield* unlessRefused(file, kind === "decision" ? decisionStateOf(folder, front, stateOf) : stateOf(folder, front))
    const hold = yield* unlessRefused(file, kind === "decision" ? holdOf({ ...front, answer: undefined, answered_at: undefined, decider: undefined }) : holdOf(front))
    if (heldWhileActive(hold, state)) {
      return yield* new TaskFileError({ file, detail: "a " + state.kind + " task carries an unanswered hold" })
    }
    const parked = yield* unlessRefused(file, parkedOf(front))
    if (closedWithUnansweredQuestion(parked, state)) {
      return yield* new TaskFileError({ file, detail: "a closed task carries an unanswered parked question" })
    }
    return {
      ...(front.ci_reruns === undefined ? {} : { ciReruns: front.ci_reruns }),
      spec: {
        id: front.id,
        title: front.title,
        project: front.project,
        kind,
        internal: front.internal ?? false,
        machine: front.machine,
        parent: front.parent ?? null,
        split: front.split ?? null,
        dependsOn: front.depends_on,
        priority: front.priority ?? null,
        created: front.created,
        body: parts.body
      },
      hold,
      ...(front.retry === undefined ? {} : { retry: front.retry }),
      ...(front.rebase === undefined ? {} : { rebase: front.rebase }),
      ...(front.ci_sent_back === undefined ? {} : { ciSentBack: front.ci_sent_back }),
      parked,
      ...(front.merge === undefined ? {} : { merge: front.merge }),
      ...priorPrOf(front.pr, state),
      state
    }
  })
