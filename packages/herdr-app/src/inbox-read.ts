import { askingRuns, attention } from "./guard"
import { type InboxItem, type InboxSources, inboxItems, inboxTasks } from "./inbox"
import { type Reading, readJson } from "./orc-read"
import { taskDetails, thread } from "./task-guard"
import type { Thread } from "./thread"

export interface InboxDocuments {
  readonly items: ReadonlyArray<InboxItem>
  readonly unread: ReadonlyMap<string, string>
}

export const readInboxItems = (sources: Omit<InboxSources, "threads">): Promise<InboxDocuments> =>
  Promise.all(inboxTasks(sources).map((id) =>
    readJson("orc", ["backlog", "thread", id, "--json"], thread).then((reading) => ({ id, reading }))
  )).then((told) => {
    const threads = new Map<string, Thread>()
    const unread = new Map<string, string>()
    for (const { id, reading } of told) {
      if (reading.kind === "failed") unread.set(id, reading.reason)
      if (reading.kind === "ok") threads.set(reading.value.task, reading.value)
    }
    return { items: inboxItems({ ...sources, threads }), unread }
  })

export const readInbox = (): Promise<Reading<InboxDocuments>> =>
  Promise.all([
    readJson("orc", ["backlog", "--json"], taskDetails),
    readJson("orc", ["attention", "--json"], attention),
    readJson("orc", ["runs", "--json"], askingRuns)
  ]).then(([backlog, asked, runs]) => {
    if (backlog.kind !== "ok") return backlog
    if (asked.kind !== "ok") return asked
    if (runs.kind !== "ok") return runs
    return readInboxItems({ backlog: backlog.value, attention: asked.value, runs: runs.value })
      .then((value) => ({ kind: "ok" as const, value }))
  })
