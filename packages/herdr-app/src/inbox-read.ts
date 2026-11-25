import { type AttentionItem, type AttentionQueue, type DecidedAttention, attention } from "./guard-attention"
import { type InboxItem, inboxItems } from "./inbox"
import { type Reading, readJson } from "./orc-read"
import type { TaskDetail } from "./task"
import { taskDetails } from "./task-guard"

export interface AgentAttention {
  readonly pending: ReadonlyArray<AttentionItem>
  readonly decided: ReadonlyArray<DecidedAttention>
}

export interface InboxDocuments {
  readonly items: ReadonlyArray<InboxItem>
  readonly agent: AgentAttention
}

export const inboxDocuments = (backlog: ReadonlyArray<TaskDetail>, queue: AttentionQueue): InboxDocuments => ({
  items: inboxItems(backlog, queue.items),
  agent: { pending: queue.items.filter((item) => item.owner === "decider"), decided: queue.decided }
})

export const readInbox = (): Promise<Reading<InboxDocuments>> =>
  Promise.all([
    readJson("orc", ["backlog", "--json"], taskDetails),
    readJson("orc", ["attention", "--json"], attention)
  ]).then(([backlog, asked]) => {
    if (backlog.kind !== "ok") return backlog
    if (asked.kind !== "ok") return asked
    return { kind: "ok", value: inboxDocuments(backlog.value, asked.value) }
  })
