import type { AttentionItem } from "./guard-attention"
import { type AnswerTarget, type TaskDetail, answerArgv, mergeArgv } from "./task"
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

const openPr = (task: TaskDetail | undefined): string | null =>
  task?.state.status === "closed" && (task.prState === "open" || task.prState === null) ? task.state.pr : null

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
      ...(option.outcome ? { outcome: option.outcome } : {})
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
  if ((item.kind === "pr-ready" || item.kind === "check-red") && isSettledPr(task)) return null
  if (item.kind === "pr-ready") {
    const link = openPr(task)
    if (link !== null) return { ...base, kind: "pr", link, action: { kind: "merge", argv: mergeArgv(item.task), attentionId: item.id } }
  }
  return { ...base, kind: "event", action: { kind: "event", id: item.id } }
}

const holdCards = (task: TaskDetail, overdue: boolean): ReadonlyArray<InboxAnswer> => {
  const hold = task.hold
  if (task.state.status === "closed" || hold === null || hold.answer !== null) return []
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
  return [
    ...userItems.map((item) => attentionCard(item, tasks.get(item.task))).filter((item) => item !== null),
    ...backlog.flatMap((task) => holdCards(task, overdue.has(task.id)))
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
  if (item.action.kind === "unavailable") return { kind: "unavailable" }
  if (item.action.kind === "overdue-hold") return { kind: "write", prefix: option.text, label: option.text === "drop" ? "Give a reason for dropping the task" : "Write an answer to the hold" }
  if (item.action.kind === "answer" && option.outcome !== undefined) {
    const prefix = /^(answer|fix) <(?:words|how)>$/.exec(option.text)?.[1]
    if (prefix !== undefined) return { kind: "write", prefix, label: prefix === "fix" ? "Say what to fix" : "Write an answer" }
  }
  return { kind: "reply", words: option.text }
}

export const inboxArgv = (item: InboxItem, text: string, prefix = ""): ReadonlyArray<string> | null => {
  const words = text.trim()
  if (words === "") return null
  switch (item.action.kind) {
    case "unavailable": return null
    case "answer": return answerArgv(item.task, item.action.target, prefix === "fix" ? `fix ${words}` : words)
    case "overdue-hold": return prefix === "drop" ? ["backlog", "drop", item.task, ...(words.startsWith("-") ? ["--"] : []), words] : answerArgv(item.task, { kind: "hold" }, words)
    case "event": return eventArgv(item.action.id, words)
    case "merge": return item.action.attentionId === undefined || words === "merge" ? null : eventArgv(item.action.attentionId, words)
  }
}
