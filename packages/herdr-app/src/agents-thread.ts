import type { Element } from "gpui-kit"
import { type Card, cardAnswers } from "./agents"
import type { LocalAgents } from "./agents-read"
import type { AgentsActions, Keyed } from "./agents-view"
import { holdsOnTasks } from "./inbox"
import type { InboxAnswers } from "./inbox-view"
import { alert } from "./kit"
import type { palette } from "./palette"
import { type Thread, threadCards } from "./thread"
import { readOnlyThread, threadDecided, threadEntry } from "./thread-view"

type Palette = ReturnType<typeof palette>

interface ThreadSources {
  readonly answers: InboxAnswers
  readonly local: LocalAgents | null
  readonly told: Keyed<Thread> | null
}

export const threadShown = (t: Palette, card: Card | null, act: AgentsActions, from: ThreadSources): ReadonlyArray<Element> => {
  if (card === null) return []
  const asked = cardAnswers(card).map((item) => from.answers.askCard(t, item, (approval) => act.askMerge(card, approval)))
  const task = from.local?.details.find((detail) => detail.id === card.id)
  if (task === undefined) {
    return [alert(t, "thread-none", { tone: "neutral", title: "This run has no task in the backlog", body: "A thread belongs to a backlog task, so this run has none." }), ...asked]
  }
  const told = from.told?.of === task.id ? from.told.reading : { kind: "reading" } as const
  if (told.kind === "reading") return [alert(t, "thread-reading", { tone: "info", title: "Reading the thread", body: `orc backlog thread ${task.id} --json` }), ...asked]
  if (told.kind === "failed") {
    return [alert(t, "thread-failed", { tone: "error", title: "Could not read the thread", body: told.reason, actions: [{ id: "thread-retry", label: "Retry", press: act.retry }] }), ...asked]
  }
  const waitsOn = holdsOnTasks(from.local?.details ?? []).get(task.id)
  const history = threadCards(told.value, task, waitsOn).filter((entry) => entry.reply === null)
  const decided = threadDecided(t, told.value)
  if (asked.length === 0 && history.length === 0 && decided.length === 0) {
    return [alert(t, "thread-empty", { tone: "neutral", title: "No thread yet", body: "Questions, answers and notes on this task show here." })]
  }
  return [...history.map((entry) => threadEntry(t, entry, readOnlyThread)), ...decided, ...asked]
}
