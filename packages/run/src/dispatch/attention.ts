import { Effect, FileSystem, Schema } from "effect"
import { readNames } from "./backlog"
import { BacklogError, platformFailure, publishOnce, readIfPresent, scratchName } from "./backlog-write"
import type { TaskRecord } from "./task-record"

const overdueMillis = 5 * 60 * 1000

export const deciderTimeoutMillis = 180 * 1000
const deciderClaimMillis = deciderTimeoutMillis + 60 * 1000

const Answer = Schema.Struct({ words: Schema.String, at: Schema.String })

const Decision = Schema.Struct({ kind: Schema.Literals(["answered", "escalated"]), reason: Schema.String, at: Schema.String })

const AttentionItem = Schema.Struct({
  kind: Schema.Literals(["review-question"]),
  task: Schema.String,
  text: Schema.String,
  asked: Schema.String,
  owner: Schema.Literals(["decider", "user"]),
  decision: Schema.optionalKey(Decision),
  deciding: Schema.optionalKey(Schema.Struct({ at: Schema.String })),
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("open") }),
    Schema.Struct({ kind: Schema.Literal("closed"), answer: Answer }),
    Schema.Struct({ kind: Schema.Literal("withdrawn"), reason: Schema.String, at: Schema.String })
  ])
})

export type AttentionItem = typeof AttentionItem.Type
export type Asked = Omit<AttentionItem, "state" | "decision" | "deciding">
type ItemAnswer = typeof Answer.Type
export type Decision = typeof Decision.Type

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

// The same question at the same asking always names one file, so routing it again opens nothing new.
export const reviewQuestionId = (task: string, question: string, asked: string): string =>
  [task, question, asked].map((part) => part.replace(/[^A-Za-z0-9_-]/g, "_")).join(".")

export const openItem = (root: string, id: string, asked: Asked): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = attentionFolder(root)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    return yield* publishOnce(folder, id + fileSuffix, yield* encodeItem(id, { ...asked, state: { kind: "open" } }))
  })

const readItem = (root: string, id: string): Effect.Effect<AttentionItem | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = itemFile(root, id)
    const text = yield* readIfPresent(file)
    if (text === null) {
      return null
    }
    return yield* Schema.decodeEffect(ItemFile)(text).pipe(Effect.mapError((error) => new BacklogError({ detail: file + " holds no item orc reads: " + error.message })))
  })

type CloseOutcome = "closed" | "already closed" | "missing"

type SettledState = Exclude<AttentionItem["state"], { kind: "open" }>

const settleOpenItem = (root: string, id: string, state: SettledState): Effect.Effect<"settled" | "already closed" | "missing", BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = itemFile(root, id)
    const before = yield* readIfPresent(file)
    if (before === null) {
      return "missing" as const
    }
    const item = yield* Schema.decodeEffect(ItemFile)(before).pipe(Effect.mapError((error) => new BacklogError({ detail: file + " holds no item orc reads: " + error.message })))
    if (item.state.kind !== "open") {
      return "already closed" as const
    }
    const { deciding: _claim, ...rest } = item
    const replaced = yield* replaceItem(root, id, before, yield* encodeItem(id, { ...rest, state }))
    return replaced ? "settled" : "already closed"
  })

export const closeItem = (root: string, id: string, answer: ItemAnswer): Effect.Effect<CloseOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.map(settleOpenItem(root, id, { kind: "closed", answer }), (outcome) => outcome === "settled" ? "closed" : outcome)

// The decider's answer reaches the item through the task's answer, so only its reason is written here.
export const recordDecision = (root: string, id: string, decision: Decision): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = itemFile(root, id)
    const before = yield* readIfPresent(file)
    if (before === null) {
      return
    }
    const item = yield* Schema.decodeEffect(ItemFile)(before).pipe(Effect.mapError((error) => new BacklogError({ detail: file + " holds no item orc reads: " + error.message })))
    if (item.state.kind !== "open") {
      return
    }
    const { deciding: _claim, ...rest } = item
    const next: AttentionItem = { ...rest, decision, owner: decision.kind === "escalated" ? "user" : item.owner }
    const encoded = yield* encodeItem(id, next)
    yield* replaceItem(root, id, before, encoded).pipe(Effect.asVoid)
  })

export const claimDeciding = (root: string, id: string, at: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = itemFile(root, id)
    const before = yield* readIfPresent(file)
    if (before === null) {
      return false
    }
    const item = yield* Schema.decodeEffect(ItemFile)(before).pipe(Effect.mapError((error) => new BacklogError({ detail: file + " holds no item orc reads: " + error.message })))
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

const withdrawItem = (root: string, id: string, reason: string, at: string): Effect.Effect<WithdrawOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.map(settleOpenItem(root, id, { kind: "withdrawn", reason, at }), (outcome) => outcome === "settled" ? "withdrawn" : outcome)

export interface OpenItem {
  readonly id: string
  readonly item: AttentionItem
}

const readAllItems = (root: string): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const ids = (yield* readNames(attentionFolder(root)))
      .filter((name) => name.endsWith(fileSuffix) && !name.startsWith("."))
      .map((name) => name.slice(0, -fileSuffix.length))
    const read = yield* Effect.forEach(ids, (id) => readItem(root, id).pipe(Effect.map((item) => (item === null ? null : { id, item }))))
    return read
      .filter((entry): entry is OpenItem => entry !== null)
      .toSorted((left, right) => Date.parse(left.item.asked) - Date.parse(right.item.asked) || left.id.localeCompare(right.id))
  })

export const openItems = (root: string): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.map(readAllItems(root), (entries) => entries.filter((entry) => entry.item.state.kind === "open"))

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
      decided: entries.filter((entry): entry is DecidedItem => entry.item.state.kind === "closed" && entry.item.decision?.kind === "answered" && !closedTasks.has(entry.item.task))
    }
  })

export const ageMillis = (item: AttentionItem, nowMillis: number): number => Math.max(0, nowMillis - Date.parse(item.asked))

export const isOverdue = (item: AttentionItem, nowMillis: number): boolean => item.state.kind === "open" && ageMillis(item, nowMillis) > overdueMillis

export const routeReviewQuestions = (root: string, tasks: ReadonlyArray<TaskRecord>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const task of tasks) {
      if (task.state.kind === "closed") {
        continue
      }
      for (const question of task.parked?.questions ?? []) {
        const id = reviewQuestionId(task.spec.id, question.id, question.asked)
        if (question.answer !== null) {
          yield* Effect.asVoid(closeItem(root, id, { words: question.answer.words, at: question.answer.at }))
          continue
        }
        live.add(id)
        const asked = Number.isNaN(Date.parse(question.asked)) ? at : question.asked
        yield* Effect.asVoid(openItem(root, id, { kind: "review-question", task: task.spec.id, text: question.text, asked, owner: "decider" }))
      }
    }
    const tasksById = new Map(tasks.map((task) => [task.spec.id, task] as const))
    const stale = (yield* openItems(root)).filter((entry) => tasksById.has(entry.item.task) && !live.has(entry.id))
    yield* Effect.forEach(stale, (entry) => {
      const reason = tasksById.get(entry.item.task)?.state.kind === "closed" ? "task closed" : "question no longer asked"
      return Effect.asVoid(withdrawItem(root, entry.id, reason, at))
    }, { discard: true })
  })
