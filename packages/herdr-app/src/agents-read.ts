import { type Card, buildCards } from "./agents"
import { type Backlog, type Guard, backlog, ok, runs } from "./guard"
import { askingRuns, attention } from "./guard-attention"
import { readInboxItems } from "./inbox-read"
import { type Reading, readJson } from "./orc-read"
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
  readonly unread: ReadonlyMap<string, string>
}

export const readAgents = (): Promise<Reading<AgentsDocuments>> =>
  Promise.all([
    readJson("orc", ["runs", "--json", "--local"], runs),
    readJson("orc", ["backlog", "--json"], agentsBacklog),
    readJson("orc", ["attention", "--json"], attention),
    readJson("orc", ["runs", "--json"], askingRuns)
  ]).then(([local, listed, asked, asking]) => {
    if (local.kind !== "ok") return local
    if (listed.kind !== "ok") return listed
    if (asked.kind !== "ok") return asked
    if (asking.kind !== "ok") return asking
    return readInboxItems({ backlog: listed.value.details, attention: asked.value, runs: asking.value })
      .then(({ items, unread }) => ({ kind: "ok" as const, value: { cards: buildCards(local.value, listed.value.backlog, items, new Set(unread.keys())), unread } }))
  })
