import { Effect, FileSystem, Schema } from "effect"
import { readNames } from "./backlog"
import { BacklogError, platformFailure, publishOnce, readIfPresent, scratchName } from "./backlog-write"
import type { TaskRecord } from "./task-record"

const overdueMillis = 5 * 60 * 1000

const Answer = Schema.Struct({ words: Schema.String, at: Schema.String })

const AttentionItem = Schema.Struct({
  kind: Schema.Literals(["review-question"]),
  task: Schema.String,
  text: Schema.String,
  asked: Schema.String,
  owner: Schema.Literals(["decider", "user"]),
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("open") }),
    Schema.Struct({ kind: Schema.Literal("closed"), answer: Answer }),
    Schema.Struct({ kind: Schema.Literal("withdrawn"), reason: Schema.String, at: Schema.String })
  ])
})

export type AttentionItem = typeof AttentionItem.Type
export type Asked = Omit<AttentionItem, "state">
type ItemAnswer = typeof Answer.Type

const ItemFile = Schema.fromJsonString(AttentionItem)

const fileSuffix = ".json"

const attentionFolder = (root: string): string => root + "/attention"

const itemFile = (root: string, id: string): string => attentionFolder(root) + "/" + id + fileSuffix

const encodeItem = (id: string, item: AttentionItem): Effect.Effect<string, BacklogError> =>
  Schema.encodeEffect(ItemFile)(item).pipe(Effect.mapError((error) => new BacklogError({ detail: "cannot write the item " + id + ": " + error.message })))

const writeItem = (root: string, id: string, item: AttentionItem): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const scratch = scratchName(attentionFolder(root), id)
    const file = itemFile(root, id)
    yield* fs.writeFileString(scratch, yield* encodeItem(id, item)).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })

// The same question at the same asking always names one file, so routing it again opens nothing new.
const reviewQuestionId = (task: string, question: string, asked: string): string =>
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
    const item = yield* readItem(root, id)
    if (item === null) {
      return "missing" as const
    }
    if (item.state.kind !== "open") {
      return "already closed" as const
    }
    yield* writeItem(root, id, { ...item, state })
    return "settled" as const
  })

export const closeItem = (root: string, id: string, answer: ItemAnswer): Effect.Effect<CloseOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.map(settleOpenItem(root, id, { kind: "closed", answer }), (outcome) => outcome === "settled" ? "closed" : outcome)

type WithdrawOutcome = "withdrawn" | "already closed" | "missing"

const withdrawItem = (root: string, id: string, reason: string, at: string): Effect.Effect<WithdrawOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.map(settleOpenItem(root, id, { kind: "withdrawn", reason, at }), (outcome) => outcome === "settled" ? "withdrawn" : outcome)

export interface OpenItem {
  readonly id: string
  readonly item: AttentionItem
}

export const openItems = (root: string): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const ids = (yield* readNames(attentionFolder(root)))
      .filter((name) => name.endsWith(fileSuffix) && !name.startsWith("."))
      .map((name) => name.slice(0, -fileSuffix.length))
    const read = yield* Effect.forEach(ids, (id) => readItem(root, id).pipe(Effect.map((item) => (item === null ? null : { id, item }))))
    return read
      .filter((entry): entry is OpenItem => entry !== null && entry.item.state.kind === "open")
      .toSorted((left, right) => Date.parse(left.item.asked) - Date.parse(right.item.asked) || left.id.localeCompare(right.id))
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
        yield* Effect.asVoid(openItem(root, id, { kind: "review-question", task: task.spec.id, text: question.text, asked, owner: "user" }))
      }
    }
    const tasksById = new Map(tasks.map((task) => [task.spec.id, task] as const))
    const stale = (yield* openItems(root)).filter((entry) => tasksById.has(entry.item.task) && !live.has(entry.id))
    yield* Effect.forEach(stale, (entry) => {
      const reason = tasksById.get(entry.item.task)?.state.kind === "closed" ? "task closed" : "question no longer asked"
      return Effect.asVoid(withdrawItem(root, entry.id, reason, at))
    }, { discard: true })
  })
