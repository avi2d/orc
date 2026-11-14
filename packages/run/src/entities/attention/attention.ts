import { Effect, FileSystem, Schema } from "effect"
import { readNames, BacklogError, platformFailure, publishOnce, readIfPresent, scratchName, type TaskRecord } from "../backlog/index"
import type { BeatAction } from "./beat-action"
import { checkRefusals, greenChecks, type PullRequestView, redChecks } from "../pull-request/index"
import { type FailingMark, failingText, loopQuestionId, pauseAfterFailures } from "../agent/index"

const overdueMillis = 5 * 60 * 1000

export const deciderTimeoutMillis = 180 * 1000
const deciderClaimMillis = deciderTimeoutMillis + 60 * 1000

const Answer = Schema.Struct({ words: Schema.String, at: Schema.String })

const Decision = Schema.Struct({ kind: Schema.Literals(["answered", "escalated"]), reason: Schema.String, at: Schema.String })

const AttentionItem = Schema.Struct({
  kind: Schema.Literals(["review-question", "run-died", "check-red", "pr-ready", "overdue-wait", "failing-command"]),
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

export const reviewQuestionId = (task: string, question: string, asked: string): string => itemId(task, question, asked)

export const openItem = (root: string, id: string, asked: Asked): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = attentionFolder(root)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    return yield* publishOnce(folder, id + fileSuffix, yield* encodeItem(id, { ...asked, state: { kind: "open" } }))
  })

const reviewQuestionItem = (
  task: string,
  question: { readonly id: string; readonly text: string; readonly asked: string },
  at: string
): { readonly id: string; readonly asked: Asked } => {
  const id = reviewQuestionId(task, question.id, question.asked)
  const asked: Asked = {
    kind: "review-question",
    task,
    text: question.text,
    asked: Number.isNaN(Date.parse(question.asked)) ? at : question.asked,
    owner: question.id === loopQuestionId ? "user" : "decider"
  }
  return { id, asked }
}

export const openReviewQuestions = (
  root: string,
  task: string,
  questions: ReadonlyArray<{ readonly id: string; readonly text: string; readonly asked: string }>,
  at: string
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.forEach(questions, (question) => {
    const item = reviewQuestionItem(task, question, at)
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

const readItem = (root: string, id: string): Effect.Effect<AttentionItem | null, BacklogError, FileSystem.FileSystem> =>
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

// The decider's answer reaches the item through the task's answer, so only its reason is written here.
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

const withdrawItem = (root: string, id: string, reason: string, at: string): Effect.Effect<WithdrawOutcome, BacklogError, FileSystem.FileSystem> =>
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
      decided: entries.filter((entry): entry is DecidedItem => entry.item.state.kind === "closed" && entry.item.decision?.kind === "answered" && !closedTasks.has(entry.item.task))
    }
  })

export const ageMillis = (item: AttentionItem, nowMillis: number): number => Math.max(0, nowMillis - Date.parse(item.asked))

export const isOverdue = (item: AttentionItem, nowMillis: number): boolean => item.state.kind === "open" && ageMillis(item, nowMillis) > overdueMillis

type TaskItemKind = Extract<AttentionItem["kind"], "review-question" | "overdue-wait">

const taskItemKinds: ReadonlySet<AttentionItem["kind"]> = new Set<TaskItemKind>(["review-question", "overdue-wait"])

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
  const asked: Asked | null = Date.parse(at) >= passed ? { kind: "overdue-wait", task: task.spec.id, text, asked: new Date(passed).toISOString(), owner: "user" } : null
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
      yield* replaceItem(root, id, existing.before, yield* encodeItem(id, { ...existing.item, text: asked.text, state: { kind: "open" } }))
    }
  })

const closeOrCloseReopenedTaskItem = (root: string, id: string, answer: ItemAnswer): Effect.Effect<CloseOutcome, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const outcome = yield* closeItem(root, id, answer)
    if (outcome !== "already closed") {
      return outcome
    }
    const existing = yield* readExistingItem(root, id)
    if (existing === null || existing.item.state.kind !== "withdrawn") {
      return outcome
    }
    const { deciding: _claim, ...rest } = existing.item
    const replaced = yield* replaceItem(root, id, existing.before, yield* encodeItem(id, { ...rest, state: { kind: "closed", answer } }))
    return replaced ? "closed" : "already closed"
  })

const routeOne = (root: string, id: string, asked: Asked | null, answer: ItemAnswer | null): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> => {
  if (answer !== null) {
    return Effect.as(closeOrCloseReopenedTaskItem(root, id, answer), false)
  }
  return asked === null ? Effect.succeed(false) : Effect.as(openOrReopenTaskItem(root, id, asked), true)
}

export const routeTaskItems = (root: string, tasks: ReadonlyArray<TaskRecord>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const task of tasks) {
      if (task.state.kind === "closed") {
        continue
      }
      for (const question of task.parked?.questions ?? []) {
        const item = reviewQuestionItem(task.spec.id, question, at)
        if (yield* routeOne(root, item.id, item.asked, question.answer)) {
          live.add(item.id)
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
    const closedTasks = new Set(tasks.filter((task) => task.state.kind === "closed").map((task) => task.spec.id))
    const staleFailing = (yield* openItems(root)).filter((entry) => entry.item.kind === "failing-command" && closedTasks.has(entry.item.task))
    yield* Effect.forEach(staleFailing, (entry) => Effect.asVoid(withdrawItem(root, entry.id, "task closed", at)), { discard: true })
  })

export interface FailingRead {
  readonly task: string
  readonly failing: FailingMark | null
}

const failingCommandText = (mark: FailingMark): string =>
  failingText(mark) + ". The run carries on, and orc pauses it to ask continue or stop if the same command fails " + pauseAfterFailures.toString() + " times in a row."

// Only a task whose run was read this beat settles its item, so a run the beat could not reach keeps the item it had.
export const routeFailingCommands = (root: string, reads: ReadonlyArray<FailingRead>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const read of reads) {
      if (read.failing !== null) {
        const id = itemId(read.task, "failing-command", read.failing.since)
        live.add(id)
        yield* openItem(root, id, { kind: "failing-command", task: read.task, text: failingCommandText(read.failing), asked: read.failing.since, owner: "user" })
      }
    }
    const readTasks = new Set(reads.map((read) => read.task))
    const stale = (yield* openItems(root)).filter((entry) => entry.item.kind === "failing-command" && readTasks.has(entry.item.task) && !live.has(entry.id))
    yield* Effect.forEach(stale, (entry) => Effect.asVoid(withdrawItem(root, entry.id, "the command stopped failing", at)), { discard: true })
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
    } else if (item.state.kind === "open" && item.text !== asked.text) {
      yield* writeItem(root, id, { ...asked, asked: item.asked, state: { kind: "open" } })
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
