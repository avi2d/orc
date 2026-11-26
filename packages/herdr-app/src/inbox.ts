import type { AttentionItem } from "./guard-attention"
import { type AnswerTarget, type TaskDetail, answerArgv, mergeArgv, mergeablePr } from "./task"
import { type AskOption, type AskText, type ThreadLine, askText } from "./thread"

interface InboxEntry {
  readonly key: string
  readonly task: string
  readonly title: string
  readonly who: ThreadLine["who"]
  readonly asked: string | null
  readonly ask: AskText
  readonly recommendation: string | null
  readonly overdueSeconds?: number
}

type Reply =
  | { readonly kind: "answer"; readonly target: AnswerTarget }
  | { readonly kind: "event"; readonly id: string }
  | { readonly kind: "overdue-hold" }
  | { readonly kind: "unavailable" }

export interface InboxAnswer extends InboxEntry {
  readonly kind: "question" | "decision" | "hold" | "event"
  readonly action: Reply
}

export interface InboxApproval extends InboxEntry {
  readonly kind: "pr"
  readonly link: string
  readonly action: { readonly kind: "merge"; readonly argv: ReadonlyArray<string>; readonly attentionId?: string }
}

export type InboxItem = InboxAnswer | InboxApproval

const questionKinds: ReadonlySet<string> = new Set(["worker-question", "review-question"])

const attentionKey = (...parts: ReadonlyArray<string>): string => parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "_")).join(".")

const questionReply = (item: AttentionItem, task: TaskDetail | undefined): Reply | null => {
  if (task?.state.status === "closed") return null
  const stored = task?.parked?.questions.find((question) => attentionKey(item.task, question.id, question.asked ?? "") === item.id)
  if (stored?.answer) return null
  if (task?.parked && stored === undefined) return { kind: "unavailable" }
  const parts = item.id.split(".")
  const id = stored?.id ?? (parts.length === 3 ? parts[1] : "")
  return id ? { kind: "answer", target: { kind: "question", id } } : { kind: "unavailable" }
}

const recordedAsk = (item: AttentionItem): AskText => {
  const subject = item.subject?.trim()
  const text = item.text.trim()
  return {
    question: subject || text,
    context: subject && subject !== text ? text : null,
    options: item.options.map((option, index) => ({
      letter: String.fromCharCode(65 + index), text: option.text, picture: option.picture,
      ...(option.outcome ? { outcome: option.outcome } : {}),
      ...(option.action === null ? {} : { action: option.action })
    }))
  }
}

const attentionBase = (item: AttentionItem, task: TaskDetail | undefined): InboxEntry => ({
  key: `${item.task}/${item.id}`, task: item.task, title: task?.title ?? "", who: questionKinds.has(item.kind) ? "worker" : "beat",
  asked: item.asked, ask: recordedAsk(item), recommendation: item.decision?.recommendation ?? item.recommendation,
  ...(item.overdueSeconds === null ? {} : { overdueSeconds: item.overdueSeconds })
})

const isSettledPr = (task: TaskDetail | undefined): boolean => task?.prState === "merged" || task?.prState === "closed"

const attentionCard = (item: AttentionItem, task: TaskDetail | undefined): InboxItem | null => {
  const base = attentionBase(item, task)
  if (questionKinds.has(item.kind)) {
    const action = questionReply(item, task)
    return action === null ? null : { ...base, kind: item.decision?.kind === "escalated" ? "decision" : "question", action }
  }
  if (item.kind === "overdue-wait") return { ...base, kind: "hold", action: { kind: "overdue-hold" } }
  if (item.kind === "unasked-question") return { ...base, kind: "question", action: { kind: "unavailable" } }
  if ((item.kind === "pr-ready" || item.kind === "check-red") && isSettledPr(task)) return null
  if (item.kind === "pr-ready") {
    const link = mergeablePr(task)
    if (link !== null) return { ...base, kind: "pr", link, action: { kind: "merge", argv: mergeArgv(item.task), attentionId: item.id } }
  }
  return { ...base, kind: "event", action: { kind: "event", id: item.id } }
}

const unmergedShip = (other: TaskDetail): boolean =>
  other.kind === "ship" && other.state.status === "closed" && other.state.outcome === "done" && other.state.pr !== null && other.prState !== "merged"

const childAwaited = (child: TaskDetail): boolean => child.state.status !== "closed" || unmergedShip(child)

const dependencyAwaited = (task: TaskDetail, dependency: TaskDetail | undefined): boolean =>
  dependency === undefined || dependency.state.status !== "closed" || (task.kind === "ship" && unmergedShip(dependency))

const tasksAwaited = (task: TaskDetail, backlog: ReadonlyArray<TaskDetail>): ReadonlyArray<string> => {
  const byId = new Map(backlog.map((other) => [other.id, other]))
  const children = backlog.filter((other) => other.parent === task.id && childAwaited(other)).map((child) => child.id)
  const dependencies = task.dependsOn.filter((id) => dependencyAwaited(task, byId.get(id)))
  return [...new Set([...children, ...dependencies])]
}

export const waitsOnLabel = (awaited: ReadonlyArray<string>): string => `Waits on ${awaited.join(", ")}`

// A bare hold only keeps its task from starting. While orc's scheduler still waits on other tasks, an answer would not start it either.
export const holdsOnTasks = (backlog: ReadonlyArray<TaskDetail>): ReadonlyMap<string, ReadonlyArray<string>> =>
  new Map(backlog.flatMap((task) => {
    const hold = task.hold
    if (task.state.status === "closed" || hold === null || hold.answer !== null || hold.questions.length > 0) return []
    const awaited = tasksAwaited(task, backlog)
    return awaited.length === 0 ? [] : [[task.id, awaited] as const]
  }))

const holdCards = (task: TaskDetail, overdue: boolean, onTasks: boolean): ReadonlyArray<InboxAnswer> => {
  const hold = task.hold
  if (task.state.status === "closed" || hold === null || hold.answer !== null || onTasks) return []
  const base = { task: task.id, title: task.title, who: "user", asked: hold.at, recommendation: null } as const
  if (hold.questions.length > 0) return hold.questions.filter((question) => question.answer === null).map((question) => ({
    ...base, key: `${task.id}/hold/${hold.at}/${question.id}`, kind: "hold", ask: askText(question.text),
    action: { kind: "answer", target: { kind: "question", id: question.id } }
  }))
  if (overdue) return []
  return [{ ...base, key: `${task.id}/hold/${hold.at}`, kind: "hold", ask: askText(hold.reason), action: { kind: "answer", target: { kind: "hold" } } }]
}

const millisOf = (item: InboxItem): number => {
  const millis = item.asked === null ? Number.NaN : Date.parse(item.asked)
  return Number.isNaN(millis) ? Number.MAX_SAFE_INTEGER : millis
}

export const inboxItems = (backlog: ReadonlyArray<TaskDetail>, items: ReadonlyArray<AttentionItem>): ReadonlyArray<InboxItem> => {
  const tasks = new Map(backlog.map((task) => [task.id, task]))
  const userItems = items.filter((item) => item.owner === "user")
  const overdue = new Set(userItems.filter((item) => item.kind === "overdue-wait").map((item) => item.task))
  const onTasks = holdsOnTasks(backlog)
  return [
    ...userItems.map((item) => attentionCard(item, tasks.get(item.task))).filter((item) => item !== null),
    ...backlog.flatMap((task) => holdCards(task, overdue.has(task.id), onTasks.has(task.id)))
  ].sort((left, right) => millisOf(left) - millisOf(right))
}

const eventArgv = (id: string, text: string): ReadonlyArray<string> =>
  ["attention", "answer", id, ...(text.startsWith("-") ? ["--"] : []), text]

type Choice =
  | { readonly kind: "reply"; readonly words: string }
  | { readonly kind: "write"; readonly prefix: string; readonly label: string }
  | { readonly kind: "merge" }
  | { readonly kind: "unavailable" }

export const choice = (item: InboxItem, option: AskOption): Choice => {
  if (item.action.kind === "merge" && option.text === "merge") return { kind: "merge" }
  if (item.action.kind === "unavailable" || option.action === "wait") return { kind: "unavailable" }
  if (item.action.kind === "answer" && option.action === "write-answer") return { kind: "write", prefix: "", label: "Write an answer to the question" }
  if (item.action.kind === "overdue-hold") return { kind: "write", prefix: option.text, label: option.text === "drop" ? "Give a reason for dropping the task" : "Write an answer to the hold" }
  return { kind: "reply", words: option.text }
}

export const inboxArgv = (item: InboxItem, text: string, prefix = ""): ReadonlyArray<string> | null => {
  const words = text.trim()
  if (words === "") return null
  switch (item.action.kind) {
    case "unavailable": return null
    case "answer": return answerArgv(item.task, item.action.target, words)
    case "overdue-hold": return prefix === "drop" ? ["backlog", "drop", item.task, ...(words.startsWith("-") ? ["--"] : []), words] : answerArgv(item.task, { kind: "hold" }, words)
    case "event": return eventArgv(item.action.id, words)
    case "merge": return item.action.attentionId === undefined || words === "merge" ? null : eventArgv(item.action.attentionId, words)
  }
}
