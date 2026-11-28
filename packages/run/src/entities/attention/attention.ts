import { Effect, type FileSystem } from "effect"
import { readNames, type BacklogError, isDeciderAnswer, type ParkedQuestion, taskPr, type TaskRecord } from "../backlog/index"
import { isWorkerQuestion, loopQuestionId } from "../agent/index"

export const deciderTimeoutMillis = 180 * 1000
const deciderClaimMillis = deciderTimeoutMillis + 60 * 1000

import { type AttentionItem, type Asked, type Decision, isQuestionChoice, type ItemAnswer } from "./attention-item"
import type { AnswerWords } from "../../shared/lib/index"
import type { OpenQuestion } from "../review-gate/index"
import { choice, itemId, unaskedQuestion, writtenAnswerChoice, type Choice } from "./attention-ask"
import { sameChoice, withChoice } from "./attention-choice"
import { attentionFolder, encodeItem, fileSuffix, openItem, readExistingItem, readItem, replaceItem, withItemClaim, writeItem } from "./attention-store"

export type { Asked }

export { openItem, readItem } from "./attention-store"
export { choice, itemId } from "./attention-ask"

export const reviewQuestionId = (task: string, question: string, asked: string): string => itemId(task, question, asked)

const questionSubject = (task: string, question: OpenQuestion): string =>
  question.subject ?? task + ", " + question.id + ": " + question.text.split("\n", 1)[0]

const reviewChoices = (task: string, question: OpenQuestion): Choice => {
  const subject = questionSubject(task, question)
  if (question.options !== undefined || question.recommendation !== undefined) {
    return {
      subject,
      ...(question.options === undefined ? {} : { options: question.options.map(({ text, outcome, picture, action }) => ({
        text,
        ...(outcome === undefined ? {} : { outcome }),
        ...(picture === undefined ? {} : { picture }),
        ...(action === undefined ? {} : { action })
      })) }),
      ...(question.recommendation === undefined ? {} : { recommendation: question.recommendation })
    }
  }
  return writtenAnswerChoice(task, question.id, subject, "")
}

const reviewQuestionItem = (
  task: string,
  question: OpenQuestion
): { readonly id: string; readonly asked: Asked } => ({
  id: reviewQuestionId(task, question.id, question.asked ?? ""),
  asked: {
    kind: isWorkerQuestion(question.id) ? "worker-question" : "review-question",
    task,
    text: question.text.trim() === "" ? "No text was supplied for " + question.id + ". Check the run before answering." : question.text,
    ...reviewChoices(task, question),
    asked: question.asked ?? "",
    owner: question.owner ?? (question.id === loopQuestionId ? "user" : "decider")
  }
})

const storedOptionLine = (option: Pick<ParkedQuestionOption, "text" | "outcome" | "picture">): string =>
  "- " + option.text + (option.picture === undefined ? "" : " (picture: " + option.picture + ")") + (option.outcome === undefined ? "" : ", leads to: " + option.outcome)

type ParkedQuestionOption = NonNullable<ParkedQuestion["options"]>[number]

const storedQuestionItem = (task: string, question: ParkedQuestion): { readonly id: string; readonly asked: Asked } => {
  const item = reviewQuestionItem(task, question)
  if (isQuestionChoice(item.asked)) {
    return item
  }
  const unlisted = (question.options ?? []).filter((option) => !item.asked.text.includes(option.text)).map(storedOptionLine)
  const text = unlisted.length === 0 ? item.asked.text : [item.asked.text, "Options stored with this question:", ...unlisted].join("\n")
  const reason = " orc stored this question before each option needed an outcome and a recommendation, so it recommends none of the options its text lists."
  return { id: item.id, asked: { ...item.asked, text, ...writtenAnswerChoice(task, question.id, questionSubject(task, question), reason) } }
}

export const openReviewQuestions = (
  root: string,
  task: string,
  questions: ReadonlyArray<OpenQuestion>
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.forEach(questions, (question) => {
    const item = reviewQuestionItem(task, question)
    return Effect.asVoid(openItem(root, item.id, item.asked))
  }, { discard: true })

type ItemWrite = (root: string, id: string, asked: Asked) => Effect.Effect<void, BacklogError, FileSystem.FileSystem>

const whenAlreadyOpened = (onExisting: ItemWrite): ItemWrite => (root, id, asked) =>
  Effect.flatMap(openItem(root, id, asked), (opened) => opened ? Effect.void : onExisting(root, id, asked))

export const openOrRefreshItem: ItemWrite = whenAlreadyOpened((root, id, asked) =>
  withItemClaim(root, id, Effect.gen(function*() {
    const item = yield* readItem(root, id)
    if (item === null || item.state.kind === "closed" || (item.state.kind === "open" && item.text === asked.text && item.owner === asked.owner && sameChoice(item, asked))) {
      return
    }
    const next: AttentionItem = item.state.kind === "withdrawn"
      ? { ...asked, state: { kind: "open" } }
      : withChoice(item, asked)
    yield* writeItem(root, id, yield* encodeItem(id, next))
  })))

type CloseOutcome = "closed" | "already closed" | "missing"

type SettledState = Exclude<AttentionItem["state"], { kind: "open" }>

const settleOpenItem = (root: string, id: string, state: SettledState): Effect.Effect<"settled" | "already closed" | "missing", BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if ((yield* readItem(root, id)) === null) {
      return "missing" as const
    }
    return yield* withItemClaim(root, id, Effect.gen(function*() {
      const item = yield* readItem(root, id)
      if (item === null) {
        return "missing" as const
      }
      if (item.state.kind !== "open") {
        return "already closed" as const
      }
      const { deciding: _claim, ...rest } = item
      yield* writeItem(root, id, yield* encodeItem(id, { ...rest, state }))
      return "settled" as const
    }))
  })

export const closeItem = (root: string, id: string, answer: ItemAnswer): Effect.Effect<CloseOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.map(settleOpenItem(root, id, { kind: "closed", answer }), (outcome) => outcome === "settled" ? "closed" : outcome)

// The decider's answer reaches the item through the task's answer, so only its decision is written here.
export const recordDecision = (root: string, id: string, decision: Decision): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const existing = yield* readExistingItem(root, id)
    if (existing === null) {
      return
    }
    const { before, item } = existing
    if (item.state.kind === "closed") {
      return
    }
    const { deciding: _claim, ...rest } = item
    const next: AttentionItem = { ...rest, decision, owner: decision.kind === "escalated" ? "user" : item.owner }
    const encoded = yield* encodeItem(id, next)
    yield* replaceItem(root, id, before, encoded).pipe(Effect.asVoid)
  })

export const claimDeciding = (root: string, id: string, at: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const current = yield* readExistingItem(root, id)
    if (current === null) {
      return false
    }
    const { before, item } = current
    if (item.state.kind !== "open") {
      return false
    }
    const since = item.deciding === undefined ? Number.NaN : Date.parse(item.deciding.at)
    if (!Number.isNaN(since) && Date.parse(at) - since < deciderClaimMillis) {
      return false
    }
    return yield* replaceItem(root, id, before, yield* encodeItem(id, { ...item, deciding: { at } }))
  })

type WithdrawOutcome = "withdrawn" | "already closed" | "missing"

export const withdrawItem = (root: string, id: string, reason: string, at: string): Effect.Effect<WithdrawOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.map(settleOpenItem(root, id, { kind: "withdrawn", reason, at }), (outcome) => outcome === "settled" ? "withdrawn" : outcome)

export interface OpenItem {
  readonly id: string
  readonly item: AttentionItem
}

const readAllItems = (root: string, keep?: (name: string) => boolean): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const ids = (yield* readNames(attentionFolder(root)))
      .filter((name) => name.endsWith(fileSuffix) && !name.startsWith(".") && (keep === undefined || keep(name)))
      .map((name) => name.slice(0, -fileSuffix.length))
    const read = yield* Effect.forEach(ids, (id) => readItem(root, id).pipe(Effect.map((item) => (item === null ? null : { id, item }))), { concurrency: 8 })
    return read
      .filter((entry): entry is OpenItem => entry !== null)
      .toSorted((left, right) => Date.parse(left.item.asked) - Date.parse(right.item.asked) || left.id.localeCompare(right.id))
  })

export const openItems = (root: string, keep?: (name: string) => boolean): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.map(readAllItems(root, keep), (entries) => entries.filter((entry) => entry.item.state.kind === "open"))

export const taskItems = (root: string, task: string): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.map(readAllItems(root), (entries) => entries.filter((entry) => entry.item.task === task))

export interface DecidedItem {
  readonly id: string
  readonly item: AttentionItem
}

export interface AttentionSnapshot {
  readonly open: ReadonlyArray<OpenItem>
  readonly decided: ReadonlyArray<DecidedItem>
}

export const readAttention = (root: string, tasks: ReadonlyArray<TaskRecord>): Effect.Effect<AttentionSnapshot, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const closedTasks = new Set(tasks.filter((task) => task.state.kind === "closed").map((task) => task.spec.id))
    const entries = yield* readAllItems(root)
    return {
      open: entries.filter((entry) => entry.item.state.kind === "open"),
      decided: entries.filter((entry): entry is DecidedItem =>
        entry.item.state.kind === "closed" && !closedTasks.has(entry.item.task))
    }
  })

type TaskItemKind = Extract<AttentionItem["kind"], "review-question" | "worker-question" | "overdue-wait" | "unasked-question">

const taskItemKinds: ReadonlySet<AttentionItem["kind"]> = new Set<TaskItemKind>(["review-question", "worker-question", "overdue-wait", "unasked-question"])

// A hold names the day it is answered by, so its wait passes once that whole day has.
const overdueWait = (task: TaskRecord, at: string): { readonly id: string; readonly asked: Asked | null; readonly answer: ItemAnswer | null } | null => {
  const hold = task.hold
  if (hold === null || hold.until === null) {
    return null
  }
  const parts = hold.until.split("-").map(Number)
  const passed = parts.length === 3 && parts.every((part) => Number.isInteger(part))
    ? new Date(parts[0], parts[1] - 1, parts[2] + 1).getTime()
    : Number.NaN
  const generation = hold.history?.length ?? 0
  const id = generation === 0 ? itemId(task.spec.id, "overdue-wait", hold.until) : itemId(task.spec.id, "overdue-wait", hold.until, String(generation))
  const text = "held for the captain: " + hold.reason + ", until " + hold.until + " passed"
  const options = choice(
    "the hold on " + task.spec.id + ": " + hold.reason,
    { text: "answer", outcome: "orc backlog answer " + task.spec.id + " <words> answers the hold, and the task can start" },
    { text: "drop", outcome: "orc backlog drop " + task.spec.id + " <reason> drops the task, and it never starts" }
  )
  const asked: Asked | null = Date.parse(at) >= passed ? { kind: "overdue-wait", task: task.spec.id, text, ...options, asked: new Date(passed).toISOString(), owner: "user" } : null
  return { id, asked, answer: hold.answer }
}

// openItem publishes once and cannot rewrite an item, so this rewrites a withdrawn or open one with the text the task asks now.
// A lost replace means another writer changed the item, so the item is live exactly when it reads open now.
const openOrReopenTaskItem = (root: string, id: string, asked: Asked): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (yield* openItem(root, id, asked)) {
      return true
    }
    const existing = yield* readExistingItem(root, id)
    if (existing === null || existing.item.state.kind === "closed") {
      return false
    }
    if (existing.item.state.kind === "open" && existing.item.text === asked.text && sameChoice(existing.item, asked)) {
      return true
    }
    if (yield* replaceItem(root, id, existing.before, yield* encodeItem(id, { ...withChoice(existing.item, { ...asked, owner: existing.item.owner }), state: { kind: "open" } }))) {
      return true
    }
    return (yield* readItem(root, id))?.state.kind === "open"
  })

// The task file holds the answer that stands, so an item closed on the answer it replaced takes the new one and keeps the old one.
const overturnClosedItem = (root: string, id: string, existing: { readonly before: string; readonly item: AttentionItem }, answer: ItemAnswer): Effect.Effect<CloseOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const state = existing.item.state
    if (state.kind !== "closed" || (state.answer.words === answer.words && state.answer.at === answer.at)) {
      return "already closed"
    }
    const replaced = yield* replaceItem(root, id, existing.before, yield* encodeItem(id, { ...existing.item, state: { kind: "closed", answer, overturned: state.answer } }))
    return replaced ? "closed" : "already closed"
  })

const closeOrCloseReopenedTaskItem = (root: string, id: string, answer: ItemAnswer, overturns: boolean): Effect.Effect<CloseOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const outcome = yield* closeItem(root, id, answer)
    if (outcome !== "already closed") {
      return outcome
    }
    const existing = yield* readExistingItem(root, id)
    if (existing !== null && existing.item.state.kind === "closed" && overturns) {
      return yield* overturnClosedItem(root, id, existing, answer)
    }
    if (existing === null || existing.item.state.kind !== "withdrawn") {
      return outcome
    }
    const { deciding: _claim, ...rest } = existing.item
    const replaced = yield* replaceItem(root, id, existing.before, yield* encodeItem(id, { ...rest, state: { kind: "closed", answer } }))
    return replaced ? "closed" : "already closed"
  })

const routeOne = (root: string, id: string, asked: Asked | null, answer: ItemAnswer | null, overturns = false): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> => {
  if (answer !== null) {
    return Effect.as(closeOrCloseReopenedTaskItem(root, id, answer, overturns), false)
  }
  return asked === null ? Effect.succeed(false) : openOrReopenTaskItem(root, id, asked)
}

const routeQuestion = (root: string, task: string, question: ParkedQuestion): Effect.Effect<string | null, BacklogError, FileSystem.FileSystem> => {
  const item = storedQuestionItem(task, question)
  const answer = question.answer
  // An ask back hands the worker a question of its own, so its item waits on in the queue.
  const closing = answer === null || answer.by === "asked-back" ? null : answer
  const overturns = closing !== null && !isDeciderAnswer(closing) && closing.overturned !== undefined
  return Effect.map(routeOne(root, item.id, item.asked, closing === null ? null : { words: closing.words, at: closing.at, decider: closing.decider }, overturns), (live) => live ? item.id : null)
}

const closeAskedBackEarlier = (root: string, task: TaskRecord, asked: string, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    for (const entry of yield* taskItems(root, task.spec.id)) {
      const decision = entry.item.decision
      if (entry.item.kind !== "worker-question" || entry.item.state.kind !== "open" || decision?.kind !== "asked-back" || !(Date.parse(decision.at) < Date.parse(asked))) {
        continue
      }
      const stored = task.parked?.questions.find((candidate) => reviewQuestionId(task.spec.id, candidate.id, candidate.asked) === entry.id)?.answer
      if (stored === null || stored === undefined) {
        continue
      }
      yield* Effect.asVoid(closeItem(root, entry.id, { words: stored.words, at, decider: stored.decider }))
    }
  })

const routeTask = (root: string, task: TaskRecord, at: string): Effect.Effect<ReadonlyArray<string>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live: Array<string> = []
    const unasked: Array<ParkedQuestion> = []
    for (const question of task.parked?.questions ?? []) {
      const id = yield* routeQuestion(root, task.spec.id, question)
      if (id !== null) {
        live.push(id)
        continue
      }
      const answer = question.answer
      if (answer === null && question.blocks && task.state.kind === "new") {
        unasked.push(question)
      }
      if (answer !== null && answer.by !== "asked-back" && isWorkerQuestion(question.id)) {
        yield* closeAskedBackEarlier(root, task, question.asked, at)
      }
    }
    const silent = unaskedQuestion(task, unasked, at)
    if (silent !== null && (yield* openOrReopenTaskItem(root, silent.id, silent.asked))) {
      live.push(silent.id)
    }
    const wait = overdueWait(task, at)
    if (wait !== null && (yield* routeOne(root, wait.id, wait.asked, wait.answer))) {
      live.push(wait.id)
    }
    return live
  })

export const withdrawTaskItems = (root: string, tasks: ReadonlyArray<string>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const closing = new Set(tasks)
    for (const entry of yield* openItems(root)) {
      if (closing.has(entry.item.task)) {
        yield* withdrawItem(root, entry.id, "task closed", at)
      }
    }
  })

const staleTaskItemReasons: Partial<Record<AttentionItem["kind"], string>> = {
  "overdue-wait": "hold no longer waits",
  "unasked-question": "each question it named has an answer or an open item"
}

const staleItemReason = (item: AttentionItem, task: TaskRecord, live: boolean): string | null => {
  if (taskItemKinds.has(item.kind) && !live) {
    return task.state.kind === "closed" ? "task closed" : staleTaskItemReasons[item.kind] ?? "question no longer asked"
  }
  if (task.state.kind !== "closed") {
    return null
  }
  const prItem = item.kind === "check-red" || item.kind === "pr-ready"
  return item.kind === "failing-command" || item.kind === "machine-unreached" || (prItem && taskPr(task) === null) ? "task closed" : null
}

export const routeTaskItems = (root: string, tasks: ReadonlyArray<TaskRecord>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const task of tasks.filter((candidate) => candidate.state.kind !== "closed")) {
      for (const id of yield* routeTask(root, task, at)) {
        live.add(id)
      }
    }
    const tasksById = new Map(tasks.map((task) => [task.spec.id, task] as const))
    for (const entry of yield* openItems(root)) {
      const task = tasksById.get(entry.item.task)
      const reason = task === undefined ? null : staleItemReason(entry.item, task, live.has(entry.id))
      if (reason !== null) {
        yield* withdrawItem(root, entry.id, reason, at)
      }
    }
  })

export type AnswerItemOutcome = CloseOutcome | { readonly kind: "answered elsewhere"; readonly task: string }

export const answerItem = (root: string, id: string, answer: typeof AnswerWords.Type): Effect.Effect<AnswerItemOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const item = yield* readItem(root, id)
    if (item !== null && taskItemKinds.has(item.kind)) {
      return { kind: "answered elsewhere", task: item.task } as const
    }
    return yield* closeItem(root, id, { ...answer, decider: "owner" })
  })
