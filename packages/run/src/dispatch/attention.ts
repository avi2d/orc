import { Effect, FileSystem, Schema } from "effect"
import { readNames } from "./backlog"
import { BacklogError, platformFailure, publishOnce, readIfPresent, scratchName } from "./backlog-write"
import type { BeatAction } from "./beat-action"
import { checkRefusals, greenChecks, type PullRequestView, redChecks } from "./pr-view"
import type { TaskRecord } from "./task-record"

const overdueMillis = 5 * 60 * 1000

const Answer = Schema.Struct({ words: Schema.String, at: Schema.String })

const AttentionItem = Schema.Struct({
  kind: Schema.Literals(["review-question", "run-died", "check-red", "pr-ready", "overdue-wait"]),
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

// The same parts always name one file, so routing an item again opens nothing new.
const itemId = (...parts: ReadonlyArray<string>): string => parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "_")).join(".")

const reviewQuestionId = (task: string, question: string, asked: string): string => itemId(task, question, asked)

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

export const openItems = (root: string, keep?: (name: string) => boolean): Effect.Effect<ReadonlyArray<OpenItem>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const ids = (yield* readNames(attentionFolder(root)))
      .filter((name) => name.endsWith(fileSuffix) && !name.startsWith(".") && (keep === undefined || keep(name)))
      .map((name) => name.slice(0, -fileSuffix.length))
    const read = yield* Effect.forEach(ids, (id) => readItem(root, id).pipe(Effect.map((item) => (item === null ? null : { id, item }))))
    return read
      .filter((entry): entry is OpenItem => entry !== null && entry.item.state.kind === "open")
      .toSorted((left, right) => Date.parse(left.item.asked) - Date.parse(right.item.asked) || left.id.localeCompare(right.id))
  })

export const ageMillis = (item: AttentionItem, nowMillis: number): number => Math.max(0, nowMillis - Date.parse(item.asked))

export const isOverdue = (item: AttentionItem, nowMillis: number): boolean => item.state.kind === "open" && ageMillis(item, nowMillis) > overdueMillis

type TaskItemKind = Extract<AttentionItem["kind"], "review-question" | "overdue-wait">

const taskItemKinds: ReadonlySet<AttentionItem["kind"]> = new Set<TaskItemKind>(["review-question", "overdue-wait"])

const dayMillis = 24 * 60 * 60 * 1000

// A hold names the day it is answered by, so its wait passes once that whole day has.
const overdueWait = (task: TaskRecord, at: string): { readonly id: string; readonly asked: Asked | null; readonly answer: ItemAnswer | null } | null => {
  const hold = task.hold
  if (hold === null || hold.until === null) {
    return null
  }
  const passed = Date.parse(hold.until) + dayMillis
  const id = itemId(task.spec.id, "overdue-wait", hold.until)
  const text = "held for the captain: " + hold.reason + ", until " + hold.until + " passed"
  const asked: Asked | null = Date.parse(at) >= passed ? { kind: "overdue-wait", task: task.spec.id, text, asked: new Date(passed).toISOString(), owner: "user" } : null
  return { id, asked, answer: hold.answer }
}

const routeOne = (root: string, id: string, asked: Asked | null, answer: ItemAnswer | null): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> => {
  if (answer !== null) {
    return Effect.as(closeItem(root, id, answer), false)
  }
  return asked === null ? Effect.succeed(false) : Effect.as(openItem(root, id, asked), true)
}

export const routeTaskItems = (root: string, tasks: ReadonlyArray<TaskRecord>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const task of tasks) {
      if (task.state.kind === "closed") {
        continue
      }
      for (const question of task.parked?.questions ?? []) {
        const id = reviewQuestionId(task.spec.id, question.id, question.asked)
        const asked = Number.isNaN(Date.parse(question.asked)) ? at : question.asked
        if (yield* routeOne(root, id, { kind: "review-question", task: task.spec.id, text: question.text, asked, owner: "user" }, question.answer)) {
          live.add(id)
        }
      }
      const wait = overdueWait(task, at)
      if (wait !== null && (yield* routeOne(root, wait.id, wait.asked, wait.answer))) {
        live.add(wait.id)
      }
    }
    const tasksById = new Map(tasks.map((task) => [task.spec.id, task] as const))
    const stale = (yield* openItems(root)).filter((entry) => taskItemKinds.has(entry.item.kind) && tasksById.has(entry.item.task) && !live.has(entry.id))
    yield* Effect.forEach(stale, (entry) => {
      const ended = entry.item.kind === "review-question" ? "question no longer asked" : "hold no longer waits"
      const reason = tasksById.get(entry.item.task)?.state.kind === "closed" ? "task closed" : ended
      return Effect.asVoid(withdrawItem(root, entry.id, reason, at))
    }, { discard: true })
  })

export const openRunDeaths = (root: string, actions: ReadonlyArray<BeatAction>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.forEach(actions, (action) =>
    (action.kind === "closed" && action.outcome === "failed") || action.kind === "start-failed"
      ? Effect.asVoid(openItem(root, itemId(action.task, "run-died"), { kind: "run-died", task: action.task, text: "the run on " + action.machine + " died: " + action.reason, asked: at, owner: "user" }))
      : Effect.void, { discard: true })

const openOrReopenPrItem = (root: string, id: string, asked: Asked): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const item = yield* readItem(root, id)
    if (item === null) {
      yield* Effect.asVoid(openItem(root, id, asked))
    } else if (item.state.kind === "withdrawn") {
      yield* writeItem(root, id, { ...asked, state: { kind: "open" } })
    }
  })

// Each head commit gets its own items, so a fix pushed after a red check opens anew.
export const routePullRequest = (root: string, task: string, pr: string, view: PullRequestView, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const ended = view.state === "MERGED" ? "merged" : view.state === "CLOSED" ? "closed without merging" : null
    const refusals = checkRefusals(view)
    const red = redChecks(view)
    const holds = (kind: AttentionItem["kind"]): boolean => ended === null && (kind === "check-red" ? refusals.length > 0 : red.length === 0)
    const prefixes = [itemId(task, "check-red") + ".", itemId(task, "pr-ready") + "."]
    const settled = (yield* openItems(root, (name) => prefixes.some((prefix) => name.startsWith(prefix)))).filter((entry) =>
      !(entry.id === itemId(task, entry.item.kind, view.headRefOid) && holds(entry.item.kind))
    )
    yield* Effect.forEach(settled, (entry) =>
      entry.item.kind === "pr-ready" && ended !== null
        ? Effect.asVoid(closeItem(root, entry.id, { words: ended, at }))
        : Effect.asVoid(withdrawItem(root, entry.id, ended === null ? "head or checks changed" : "PR " + ended, at)), { discard: true })
    if (ended !== null) {
      return
    }
    if (red.length > 0) {
      yield* openOrReopenPrItem(root, itemId(task, "check-red", view.headRefOid), { kind: "check-red", task, text: pr + ": the check " + red.join(", ") + " is red", asked: at, owner: "user" })
    } else if (refusals.length === 0) {
      yield* openOrReopenPrItem(root, itemId(task, "pr-ready", view.headRefOid), { kind: "pr-ready", task, text: pr + " is ready to merge, checks green: " + greenChecks(view).join(", "), asked: at, owner: "user" })
    }
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
