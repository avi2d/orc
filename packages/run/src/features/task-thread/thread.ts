import { Effect, type FileSystem } from "effect"
import { reviewQuestionId, taskItems, type OpenItem } from "../../entities/attention/index"
import { findTask, readNotes, type BacklogError, type Hold, type HoldQuestion, type ParkedQuestion, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { formatTable } from "../../shared/lib/index"

const THREAD_JSON_SCHEMA = "orc.thread.v1" as const

const threadWhos = ["user", "decider", "worker", "beat"] as const
type ThreadWho = typeof threadWhos[number]

type ThreadKind = "hold" | "question" | "decision" | "answer" | "delivered" | "withdrawn" | "note"

interface ThreadEntry {
  readonly at: string | null
  readonly who: ThreadWho
  readonly kind: ThreadKind
  readonly id: string | null
  readonly text: string
}

interface ThreadJson {
  readonly schema: typeof THREAD_JSON_SCHEMA
  readonly task: string
  readonly entries: ReadonlyArray<ThreadEntry>
}

interface Placed {
  readonly place: number
  readonly entry: ThreadEntry
}

type Exchange = ReadonlyArray<ThreadEntry>

const millisOf = (at: string | null): number | null => {
  if (at === null) {
    return null
  }
  const millis = Date.parse(at)
  return Number.isNaN(millis) ? null : millis
}

// An entry with no time sorts at the next timed entry of its exchange, or at the last one when none follows.
const placeExchange = (exchange: Exchange): ReadonlyArray<Placed> => {
  const times = exchange.map((entry) => millisOf(entry.at))
  const lastTime = times.findLast((time) => time !== null) ?? Number.POSITIVE_INFINITY
  return exchange.map((entry, index) => ({ place: times.slice(index).find((time) => time !== null) ?? lastTime, entry }))
}

const entry = (at: string | null, who: ThreadWho, kind: ThreadKind, id: string | null, text: string): ThreadEntry => ({ at, who, kind, id, text })

const timeOrNull = (at: string): string | null => millisOf(at) === null ? null : at

const holdText = (hold: { readonly reason: string; readonly until: string | null }): string => hold.reason + (hold.until === null ? "" : ", until " + hold.until)

// Once every question is answered the hold's own answer is those answers joined, so it is told once through the questions.
const answeredThroughQuestions = (questions: ReadonlyArray<HoldQuestion>): boolean => questions.length > 0 && questions.every((question) => question.answer !== null)

const holdExchange = (hold: Pick<Hold, "reason" | "until" | "questions" | "answer" | "at">): Exchange => [
  entry(hold.at, "user", "hold", null, holdText(hold)),
  ...hold.questions.map((question) => entry(hold.at, "user", "question", question.id, question.text)),
  ...hold.questions.flatMap((question) => question.answer === null ? [] : [entry(question.answer.at, "user", "answer", question.id, question.answer.words)]),
  ...(hold.answer === null || answeredThroughQuestions(hold.questions) ? [] : [entry(hold.answer.at, "user", "answer", null, hold.answer.words)])
]

const holdExchanges = (hold: Hold | null): ReadonlyArray<Exchange> =>
  hold === null ? [] : [...(hold.history ?? []).map((past) => holdExchange({ ...past, at: past.at ?? null })), holdExchange(hold)]

const decidedByDecider = (item: OpenItem | undefined): boolean => item?.item.decision?.kind === "answered"

const parkedExchange = (task: string, question: ParkedQuestion, items: ReadonlyMap<string, OpenItem>): Exchange => {
  const asked = entry(timeOrNull(question.asked), "worker", "question", question.id, question.text)
  const answer = question.answer
  if (answer === null) {
    return [asked]
  }
  const who = decidedByDecider(items.get(reviewQuestionId(task, question.id, question.asked))) ? "decider" : "user"
  return [
    asked,
    entry(answer.at, who, "answer", question.id, answer.words),
    ...(answer.relayedTo === null ? [] : [entry(null, "beat", "delivered", question.id, "handed to the run that asked at " + answer.relayedTo)])
  ]
}

const askerOf = (item: OpenItem): ThreadWho => item.item.kind === "review-question" ? "worker" : "beat"

// A later park replaces the task's parked questions, so only an item whose question the task file still holds leaves its question and answer to that file.
const itemExchanges = (mirrored: ReadonlySet<string>) => (item: OpenItem): ReadonlyArray<Exchange> => {
  const { id, item: { decision, state } } = item
  const told = mirrored.has(id)
  const asked = told ? [] : [[entry(item.item.asked, askerOf(item), "question", id, item.item.text)]]
  const decided = decision === undefined ? [] : [[entry(decision.at, "decider", "decision", id, decision.kind + ": " + decision.reason)]]
  const answerer = decidedByDecider(item) ? "decider" : "user"
  const settled = state.kind === "withdrawn"
    ? [[entry(state.at, "beat", "withdrawn", id, state.reason)]]
    : state.kind === "closed" && !told ? [[entry(state.answer.at, answerer, "answer", id, state.answer.words)]] : []
  return [...asked, ...decided, ...settled]
}

const mirroredItems = (task: TaskRecord, items: ReadonlyArray<OpenItem>): ReadonlySet<string> => {
  const parked = new Set((task.parked?.questions ?? []).map((question) => reviewQuestionId(task.spec.id, question.id, question.asked)))
  return new Set(items.filter((item) => item.item.kind === "overdue-wait" || parked.has(item.id)).map((item) => item.id))
}

const noteWho = (who: string): ThreadWho => threadWhos.find((known) => known === who) ?? "user"

const kindRank: Readonly<Record<ThreadKind, number>> = { hold: 0, question: 1, decision: 2, answer: 3, delivered: 4, withdrawn: 5, note: 6 }

export const threadEntries = (
  task: TaskRecord,
  items: ReadonlyArray<OpenItem>,
  notes: ReadonlyArray<{ readonly at: string; readonly who: string; readonly text: string }>
): ReadonlyArray<ThreadEntry> => {
  const byId = new Map(items.map((item) => [item.id, item] as const))
  const exchanges: ReadonlyArray<Exchange> = [
    ...holdExchanges(task.hold),
    ...(task.parked?.questions ?? []).map((question) => parkedExchange(task.spec.id, question, byId)),
    ...items.flatMap(itemExchanges(mirroredItems(task, items))),
    ...notes.map((note) => [entry(note.at, noteWho(note.who), "note", null, note.text)])
  ]
  return exchanges
    .flatMap(placeExchange)
    .map((placed, index) => ({ ...placed, index }))
    .toSorted((left, right) => left.place - right.place || kindRank[left.entry.kind] - kindRank[right.entry.kind] || left.index - right.index)
    .map((placed) => placed.entry)
}

export const readThread = (root: string, id: string): Effect.Effect<ThreadJson, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const task = yield* findTask(root, id)
    const entries = threadEntries(task, yield* taskItems(root, id), yield* readNotes(root, id))
    return { schema: THREAD_JSON_SCHEMA, task: id, entries }
  })

const formatThread = (thread: ThreadJson): string =>
  formatTable(
    ["AT", "WHO", "KIND", "ID", "TEXT"],
    thread.entries.map((line) => [line.at ?? "-", line.who, line.kind, line.id ?? "-", line.text.replace(/\s+/g, " ").trim()]),
    "nothing is said on " + thread.task + " yet"
  )

export const threadText = (root: string, id: string, json: boolean): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.map(readThread(root, id), (thread) => json ? JSON.stringify(thread) : formatThread(thread))
