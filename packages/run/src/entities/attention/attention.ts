import { Effect, FileSystem, Schema } from "effect"
import { readNames, BacklogError, isDeciderAnswer, type ParkedQuestion, platformFailure, publishOnce, readIfPresent, scratchName, type TaskRecord } from "../backlog/index"
import { isWorkerQuestion, loopQuestionId } from "../agent/index"

export const deciderTimeoutMillis = 180 * 1000
const deciderClaimMillis = deciderTimeoutMillis + 60 * 1000

import { AttentionItem, type Asked, type AttentionOption, type Decision, type ItemAnswer } from "./attention-item"
import { AskOption } from "../review-gate/index"

export type { Asked }

const ItemFile = Schema.fromJsonString(AttentionItem)

const fileSuffix = ".json"

const attentionFolder = (root: string): string => root + "/attention"

const itemFile = (root: string, id: string): string => attentionFolder(root) + "/" + id + fileSuffix

const encodeItem = (id: string, item: AttentionItem): Effect.Effect<string, BacklogError> =>
  Schema.encodeEffect(ItemFile)(item).pipe(Effect.mapError((error) => new BacklogError({ detail: "cannot write the item " + id + ": " + error.message })))

const replaceItem = (root: string, id: string, before: string, encoded: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if ((yield* readIfPresent(itemFile(root, id))) !== before) {
      return false
    }
    const fs = yield* FileSystem.FileSystem
    const scratch = scratchName(attentionFolder(root), id)
    const file = itemFile(root, id)
    yield* fs.writeFileString(scratch, encoded).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
    return true
  })

export const writeItem = (root: string, id: string, item: AttentionItem): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const scratch = scratchName(attentionFolder(root), id)
    const file = itemFile(root, id)
    yield* fs.writeFileString(scratch, yield* encodeItem(id, item)).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })

// The same parts always name one file, so routing an item again opens nothing new.
export const itemId = (...parts: ReadonlyArray<string>): string => parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "_")).join(".")

type Choice = Pick<Asked, "subject" | "options" | "recommendation">

// The recommended option comes first, so an item cannot recommend an option it does not list.
export const choice = (subject: string, recommended: AttentionOption, ...others: ReadonlyArray<AttentionOption>): Choice =>
  ({ subject, options: [recommended, ...others], recommendation: recommended.text })

const choiceOf = (asked: Asked): Choice => ({
  ...(asked.subject === undefined ? {} : { subject: asked.subject }),
  ...(asked.options === undefined ? {} : { options: asked.options }),
  ...(asked.recommendation === undefined ? {} : { recommendation: asked.recommendation })
})

export const reviewQuestionId = (task: string, question: string, asked: string): string => itemId(task, question, asked)

export const openItem = (root: string, id: string, asked: Asked): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = attentionFolder(root)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    return yield* publishOnce(folder, id + fileSuffix, yield* encodeItem(id, { ...asked, state: { kind: "open" } }))
  })

interface AskedQuestion {
  readonly id: string
  readonly text: string
  readonly asked?: string | undefined
  readonly blocks?: boolean | undefined
  readonly options?: ReadonlyArray<AskOption> | undefined
  readonly owner?: "user" | undefined
}

const toStoredOptions = (options: ReadonlyArray<AskOption>): NonNullable<Asked["options"]> =>
  options.map((option) => ({
    text: option.text,
    ...(option.outcome === undefined ? {} : { outcome: option.outcome }),
    ...(option.picture === undefined ? {} : { picture: option.picture })
  }))

const reviewQuestionItem = (
  task: string,
  question: AskedQuestion
): { readonly id: string; readonly asked: Asked } => {
  const id = reviewQuestionId(task, question.id, question.asked ?? "")
  const asked: Asked = {
    kind: isWorkerQuestion(question.id) ? "worker-question" : "review-question",
    task,
    text: question.text,
    ...(question.options === undefined ? {} : { options: toStoredOptions(question.options) }),
    asked: question.asked ?? "",
    owner: question.owner ?? (question.id === loopQuestionId ? "user" : "decider")
  }
  return { id, asked }
}

export const openReviewQuestions = (
  root: string,
  task: string,
  questions: ReadonlyArray<AskedQuestion>
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.forEach(questions, (question) => {
    const item = reviewQuestionItem(task, question)
    return Effect.asVoid(openItem(root, item.id, item.asked))
  }, { discard: true })

const readExistingItem = (root: string, id: string): Effect.Effect<{ readonly before: string; readonly item: AttentionItem } | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = itemFile(root, id)
    const before = yield* readIfPresent(file)
    if (before === null) {
      return null
    }
    const item = yield* Schema.decodeEffect(ItemFile)(before).pipe(Effect.mapError((error) => new BacklogError({ detail: file + " holds no item orc reads: " + error.message })))
    return { before, item }
  })

export const readItem = (root: string, id: string): Effect.Effect<AttentionItem | null, BacklogError, FileSystem.FileSystem> =>
  Effect.map(readExistingItem(root, id), (existing) => existing?.item ?? null)

type CloseOutcome = "closed" | "already closed" | "missing"

type SettledState = Exclude<AttentionItem["state"], { kind: "open" }>

const settleOpenItem = (root: string, id: string, state: SettledState): Effect.Effect<"settled" | "already closed" | "missing", BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const stored = yield* readExistingItem(root, id)
    if (stored === null) {
      return "missing" as const
    }
    const { before, item } = stored
    if (item.state.kind !== "open") {
      return "already closed" as const
    }
    const { deciding: _claim, ...rest } = item
    const replaced = yield* replaceItem(root, id, before, yield* encodeItem(id, { ...rest, state }))
    return replaced ? "settled" : "already closed"
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
    const read = yield* Effect.forEach(ids, (id) => readItem(root, id).pipe(Effect.map((item) => (item === null ? null : { id, item }))))
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
        entry.item.state.kind === "closed" && (entry.item.decision?.kind === "answered" || entry.item.decision?.kind === "duplicate") && !closedTasks.has(entry.item.task))
    }
  })

type TaskItemKind = Extract<AttentionItem["kind"], "review-question" | "worker-question" | "overdue-wait">

const taskItemKinds: ReadonlySet<AttentionItem["kind"]> = new Set<TaskItemKind>(["review-question", "worker-question", "overdue-wait"])

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

// openItem publishes once and cannot rewrite a withdrawn item, so this rewrites it open with the text the task asks now.
const openOrReopenTaskItem = (root: string, id: string, asked: Asked): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (yield* openItem(root, id, asked)) {
      return
    }
    const existing = yield* readExistingItem(root, id)
    if (existing !== null && existing.item.state.kind === "withdrawn") {
      yield* replaceItem(root, id, existing.before, yield* encodeItem(id, { ...existing.item, text: asked.text, ...choiceOf(asked), state: { kind: "open" } }))
    }
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
  return asked === null ? Effect.succeed(false) : Effect.as(openOrReopenTaskItem(root, id, asked), true)
}

const routeQuestion = (root: string, task: string, question: ParkedQuestion): Effect.Effect<string | null, BacklogError, FileSystem.FileSystem> => {
  const item = reviewQuestionItem(task, question)
  const answer = question.answer
  // An ask back hands the worker a question of its own, so its item waits on in the queue.
  const closing = answer === null || answer.by === "asked-back" ? null : answer
  const overturns = closing !== null && !isDeciderAnswer(closing) && closing.overturned !== undefined
  return Effect.map(routeOne(root, item.id, item.asked, closing === null ? null : { words: closing.words, at: closing.at }, overturns), (live) => live ? item.id : null)
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
      yield* Effect.asVoid(closeItem(root, entry.id, { words: stored.words, at }))
    }
  })

const routeTask = (root: string, task: TaskRecord, at: string): Effect.Effect<ReadonlyArray<string>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live: Array<string> = []
    for (const question of task.parked?.questions ?? []) {
      const id = yield* routeQuestion(root, task.spec.id, question)
      if (id !== null) {
        live.push(id)
        continue
      }
      const answer = question.answer
      if (answer !== null && answer.by !== "asked-back" && isWorkerQuestion(question.id)) {
        yield* closeAskedBackEarlier(root, task, question.asked, at)
      }
    }
    const wait = overdueWait(task, at)
    if (wait !== null && (yield* routeOne(root, wait.id, wait.asked, wait.answer))) {
      live.push(wait.id)
    }
    return live
  })

export const routeTaskItems = (root: string, tasks: ReadonlyArray<TaskRecord>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const task of tasks.filter((candidate) => candidate.state.kind !== "closed")) {
      for (const id of yield* routeTask(root, task, at)) {
        live.add(id)
      }
    }
    const tasksById = new Map(tasks.map((task) => [task.spec.id, task] as const))
    const stale = (yield* openItems(root)).filter((entry) => taskItemKinds.has(entry.item.kind) && tasksById.has(entry.item.task) && !live.has(entry.id))
    yield* Effect.forEach(stale, (entry) => {
      const ended = entry.item.kind === "overdue-wait" ? "hold no longer waits" : "question no longer asked"
      const reason = tasksById.get(entry.item.task)?.state.kind === "closed" ? "task closed" : ended
      return Effect.asVoid(withdrawItem(root, entry.id, reason, at))
    }, { discard: true })
    const closedTasks = new Set(tasks.filter((task) => task.state.kind === "closed").map((task) => task.spec.id))
    const staleFailing = (yield* openItems(root)).filter((entry) => entry.item.kind === "failing-command" && closedTasks.has(entry.item.task))
    yield* Effect.forEach(staleFailing, (entry) => Effect.asVoid(withdrawItem(root, entry.id, "task closed", at)), { discard: true })
  })

export type AnswerItemOutcome = CloseOutcome | { readonly kind: "answered elsewhere"; readonly task: string }

export const answerItem = (root: string, id: string, answer: ItemAnswer): Effect.Effect<AnswerItemOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const item = yield* readItem(root, id)
    if (item !== null && taskItemKinds.has(item.kind)) {
      return { kind: "answered elsewhere", task: item.task } as const
    }
    return yield* closeItem(root, id, answer)
  })
