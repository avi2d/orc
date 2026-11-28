import { type Card, buildCards } from "./agents"
import { type Backlog, type Guard, type Runs, backlog, ok, runs } from "./guard"
import { type AttentionQueue, attention } from "./guard-attention"
import { holdsOnTasks } from "./inbox"
import { type AgentAttention, inboxDocuments } from "./inbox-read"
import { type Reading, rememberedJson } from "./orc-read"
import type { TaskDetail } from "./task"
import { taskDetails } from "./task-guard"

const agentsBacklog: Guard<{ readonly backlog: Backlog; readonly details: ReadonlyArray<TaskDetail> }> = (value, at) => {
  const brief = backlog(value, at)
  if (brief.kind !== "ok") return brief
  const details = taskDetails(value, at)
  return details.kind !== "ok" ? details : ok({ backlog: brief.value, details: details.value })
}

export interface AgentsDocuments {
  readonly cards: ReadonlyArray<Card>
  readonly agent: AgentAttention
}

export interface LocalAgents {
  readonly runs: Runs
  readonly backlog: Backlog
  readonly details: ReadonlyArray<TaskDetail>
}

const readLocalRuns = rememberedJson("orc", ["runs", "--json", "--local"], runs)
const readBacklog = rememberedJson("orc", ["backlog", "--json"], agentsBacklog)

export const sameLocalAgents = (left: LocalAgents | null, right: LocalAgents): boolean =>
  left !== null && left.runs === right.runs && left.backlog === right.backlog && left.details === right.details

export const readLocalAgents = (): Promise<Reading<LocalAgents>> =>
  Promise.all([readLocalRuns(), readBacklog()]).then(([local, listed]) => {
    if (local.kind !== "ok") return local
    if (listed.kind !== "ok") return listed
    return { kind: "ok", value: { runs: local.value, ...listed.value } }
  })

export const readAgentQuestions = rememberedJson("orc", ["attention", "--json"], attention)

export const agentsDocuments = (local: LocalAgents, queue: AttentionQueue): AgentsDocuments => {
  const { items, agent } = inboxDocuments(local.details, queue)
  return { cards: buildCards(local.runs, local.backlog, items, holdsOnTasks(local.details)), agent }
}

export const readAgents = (): Promise<Reading<AgentsDocuments>> =>
  Promise.all([readLocalAgents(), readAgentQuestions()]).then(([local, asked]) => {
    if (local.kind !== "ok") return local
    if (asked.kind !== "ok") return asked
    return { kind: "ok", value: agentsDocuments(local.value, asked.value) }
  })
