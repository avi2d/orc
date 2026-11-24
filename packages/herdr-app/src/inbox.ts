import type { AskingRun, AttentionItem } from "./guard-attention"
import { type AnswerTarget, type TaskDetail, mergeArgv } from "./task"
import { type AskText, type Thread, type ThreadCard, type ThreadLine, askText, threadCards } from "./thread"

type InboxAction =
  | { readonly kind: "answer"; readonly target: AnswerTarget }
  | { readonly kind: "merge"; readonly argv: ReadonlyArray<string> }

export interface InboxItem {
  readonly key: string
  readonly kind: "question" | "decision" | "hold" | "pr"
  readonly task: string
  readonly title: string
  readonly who: ThreadLine["who"]
  readonly asked: string | null
  readonly ask: AskText
  readonly recommendation: string | null
  readonly action: InboxAction | null
}

export interface InboxSources {
  readonly backlog: ReadonlyArray<TaskDetail>
  readonly attention: ReadonlyArray<AttentionItem>
  readonly runs: ReadonlyArray<AskingRun>
  readonly threads: ReadonlyMap<string, Thread>
}

const openPr = (task: TaskDetail): string | null =>
  task.state.status === "closed" && task.state.pr !== null && task.prState === "open" ? task.state.pr : null

const runAsks = (runs: ReadonlyArray<AskingRun>, task: string): boolean =>
  runs.some((run) => run.questions > 0 && (run.task === task || run.branch === `orc/${task}`))

const holdOpen = (task: TaskDetail): boolean =>
  task.hold !== null && (task.hold.answer === null || task.hold.questions.some((question) => question.answer === null))

const parkedOpen = (task: TaskDetail): boolean =>
  task.parked !== null && task.parked.questions.some((question) => question.answer === null)

const questionKinds: ReadonlySet<string> = new Set(["worker-question", "review-question"])

export const inboxTasks = (sources: Omit<InboxSources, "threads">): ReadonlyArray<string> =>
  sources.backlog.filter((task) =>
    holdOpen(task) || parkedOpen(task) || openPr(task) !== null || runAsks(sources.runs, task.id) || sources.attention.some((item) => item.task === task.id && questionKinds.has(item.kind))
  ).map((task) => task.id)

const settled = (card: ThreadCard): boolean =>
  card.answers.length > 0 || card.notes.some((note) => note.kind === "withdrawn")

const answerAction = (card: ThreadCard): InboxAction | null =>
  card.reply === null ? null : { kind: "answer", target: card.reply }

const cardItem = (task: TaskDetail, card: ThreadCard, attention: ReadonlyArray<AttentionItem>): InboxItem | null => {
  if (settled(card)) return null
  const base = { key: `${task.id}/${card.key}`, task: task.id, title: task.title, who: card.line.who, asked: card.line.at, recommendation: null, action: answerAction(card) }
  if (card.line.kind === "hold") return card.reply?.kind === "hold" ? { ...base, kind: "hold", ask: askText(card.line.text) } : null
  if (card.line.kind !== "question") return null
  const item = attention.find((entry) => entry.id === card.line.id)
  if (card.line.who === "beat") return null
  return item?.escalated === true
    ? { ...base, kind: "decision", ask: card.ask ?? askText(card.line.text), recommendation: item.recommendation }
    : { ...base, kind: "question", ask: card.ask ?? askText(card.line.text) }
}

const prItem = (task: TaskDetail): InboxItem | null => {
  const pr = openPr(task)
  if (pr === null || task.state.status !== "closed") return null
  return {
    key: `${task.id}/pr`,
    kind: "pr",
    task: task.id,
    title: task.title,
    who: "beat",
    asked: task.state.closedAt,
    ask: askText(`Merge the PR ${pr}?`),
    recommendation: null,
    action: { kind: "merge", argv: mergeArgv(task.id) }
  }
}

const millisOf = (at: string | null): number => {
  const millis = at === null ? Number.NaN : Date.parse(at)
  return Number.isNaN(millis) ? Number.MAX_SAFE_INTEGER : millis
}

export const inboxItems = (sources: InboxSources): ReadonlyArray<InboxItem> => {
  const wanted = new Set(inboxTasks(sources))
  return sources.backlog.filter((task) => wanted.has(task.id)).flatMap((task) => {
    const thread = sources.threads.get(task.id)
    const cards = thread === undefined ? [] : threadCards(thread, task)
    return [...cards.map((card) => cardItem(task, card, sources.attention)), prItem(task)].filter((item) => item !== null)
  }).sort((left, right) => millisOf(left.asked) - millisOf(right.asked))
}
