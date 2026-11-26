import { Effect, type FileSystem } from "effect"
import { decisionText, reviewQuestionId, taskItems, type Decision, type OpenItem } from "../../entities/attention/index"
import { decisionAnswer, findTask, isDeciderAnswer, readNotes, type BacklogError, type Hold, type HoldQuestion, type ParkedQuestion, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { type Decider, deciderHeadings, deciderLabel, formatTable, notRecordedBasis, oneLine } from "../../shared/lib/index"

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
  readonly recommendation?: string
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

const holdQuestionId = (generation: number, question: string): string => "hold-" + generation + "/" + question

const holdExchange = (hold: Pick<Hold, "reason" | "until" | "questions" | "answer" | "at">, generation: number): Exchange => [
  entry(hold.at, "user", "hold", null, holdText(hold)),
  ...hold.questions.map((question) => entry(hold.at, "user", "question", holdQuestionId(generation, question.id), question.text)),
  ...hold.questions.flatMap((question) => question.answer === null ? [] : [entry(question.answer.at, whoDecided(question.answer.decider), "answer", holdQuestionId(generation, question.id), question.answer.words)]),
  ...(hold.answer === null || answeredThroughQuestions(hold.questions) ? [] : [entry(hold.answer.at, whoDecided(hold.answer.decider), "answer", null, hold.answer.words)])
]

const holdExchanges = (hold: Hold | null): ReadonlyArray<Exchange> =>
  hold === null ? [] : [...(hold.history ?? []).map((past, index) => holdExchange({ ...past, at: past.at ?? null }, index + 1)), holdExchange(hold, (hold.history ?? []).length + 1)]

const whoDecided = (decider: Decider): ThreadWho => decider === "agent" ? "decider" : "user"

const parkedExchange = (task: string, question: ParkedQuestion): Exchange => {
  const id = reviewQuestionId(task, question.id, question.asked)
  const asked = entry(timeOrNull(question.asked), "worker", "question", id, question.text)
  const answer = question.answer
  if (answer === null) {
    return [asked]
  }
  const who = whoDecided(answer.decider)
  const replaced = isDeciderAnswer(answer) ? undefined : answer.overturned
  return [
    asked,
    ...(replaced === undefined ? [] : [entry(replaced.at, whoDecided(replaced.decider), "answer", id, replaced.words)]),
    entry(answer.at, who, "answer", id, replaced === undefined ? answer.words : answer.words + " (replaces the " + replaced.decider + "'s answer " + JSON.stringify(replaced.words) + ")"),
    ...(answer.relayedTo === null ? [] : [entry(null, "beat", "delivered", id, answer.relayedTo === "" ? "handed to the run that asked" : "handed to the run that asked at " + answer.relayedTo)])
  ]
}

const askerOf = (item: OpenItem): ThreadWho => item.item.kind === "review-question" || item.item.kind === "worker-question" ? "worker" : "beat"

const decisionEntry = (id: string, decision: Decision): ThreadEntry => ({
  ...entry(decision.at, whoDecided(decision.decider), "decision", id, decision.kind + ": " + decisionText(decision)),
  ...(decision.kind === "escalated" && decision.recommendation !== undefined ? { recommendation: decision.recommendation } : {})
})

// A later park replaces the task's parked questions, so only an item whose question the task file still holds leaves its question and answer to that file.
const itemExchanges = (mirrored: ReadonlySet<string>) => (item: OpenItem): ReadonlyArray<Exchange> => {
  const { id, item: { decision, state } } = item
  const told = mirrored.has(id)
  const asked = told ? [] : [[entry(item.item.asked, askerOf(item), "question", id, item.item.text)]]
  const decided = decision === undefined ? [] : [[decisionEntry(id, decision)]]
  const settled = state.kind === "withdrawn"
    ? [[entry(state.at, "beat", "withdrawn", id, state.reason)]]
    : state.kind === "closed" && !told ? [[
      ...(state.overturned === undefined ? [] : [entry(state.overturned.at, whoDecided(state.overturned.decider), "answer", id, state.overturned.words)]),
      entry(state.answer.at, whoDecided(state.answer.decider), "answer", id, state.answer.words + (state.answer.inferred === true ? " (attribution inferred)" : ""))
    ]] : []
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
  const decision = decisionAnswer(task)
  const exchanges: ReadonlyArray<Exchange> = [
    ...holdExchanges(task.hold),
    ...(decision === null ? [] : [[entry(decision.at, whoDecided(decision.decider), "answer", task.spec.id, decision.words)]]),
    ...(task.parked?.questions ?? []).map((question) => parkedExchange(task.spec.id, question)),
    ...items.flatMap(itemExchanges(mirroredItems(task, items))),
    ...notes.map((note) => [entry(note.at, noteWho(note.who), "note", null, note.text)])
  ]
  return exchanges
    .flatMap(placeExchange)
    .map((placed, index) => ({ ...placed, index }))
    .toSorted((left, right) => left.place - right.place || kindRank[left.entry.kind] - kindRank[right.entry.kind] || left.index - right.index)
    .map((placed) => placed.entry)
}

const readThread = (root: string, id: string): Effect.Effect<ThreadJson, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const task = yield* findTask(root, id)
    const entries = threadEntries(task, yield* taskItems(root, id), yield* readNotes(root, id))
    return { schema: THREAD_JSON_SCHEMA, task: id, entries }
  })

const decidedLine = (line: ThreadEntry): string => (line.id ?? "-") + ": " + oneLine(line.text)

const isAgentDecision = (line: ThreadEntry): boolean => line.kind === "decision" && line.who === "decider"

const agentGroup = (entries: ReadonlyArray<ThreadEntry>): ReadonlyArray<string> => {
  const answers = entries.filter((line) => line.kind === "answer" && line.who === "decider")
  const answered = new Set(answers.map((line) => line.id))
  const basisOf = (answer: ThreadEntry): string =>
    entries.findLast((line) => isAgentDecision(line) && line.id !== null && line.id === answer.id)?.text ?? notRecordedBasis
  return [
    ...answers.map((line) => decidedLine(line) + "\n  basis: " + oneLine(basisOf(line))),
    ...entries.filter((line) => isAgentDecision(line) && !answered.has(line.id)).map((line) => decidedLine(line))
  ]
}

const decidedGroups = (entries: ReadonlyArray<ThreadEntry>): ReadonlyArray<string> => {
  const owner = entries.filter((line) => line.kind === "answer" && line.who === "user").map(decidedLine)
  const agent = agentGroup(entries)
  return [
    ...(owner.length === 0 ? [] : [deciderHeadings.owner + ":\n" + owner.join("\n")]),
    ...(agent.length === 0 ? [] : [deciderHeadings.agent + ":\n" + agent.join("\n")])
  ]
}

const formatThread = (thread: ThreadJson): string =>
  [
    formatTable(
      ["AT", "WHO", "KIND", "ID", "TEXT"],
      thread.entries.map((line) => [line.at ?? "-", line.who === "user" ? deciderLabel("owner") : line.who === "decider" ? deciderLabel("agent") : line.who, line.kind, line.id ?? "-", oneLine(line.text)]),
      "nothing is said on " + thread.task + " yet"
    ),
    ...decidedGroups(thread.entries)
  ].join("\n\n")

export const threadText = (root: string, id: string, json: boolean): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.map(readThread(root, id), (thread) => json ? JSON.stringify(thread) : formatThread(thread))
