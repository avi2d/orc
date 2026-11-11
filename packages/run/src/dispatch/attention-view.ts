import { DateTime, Effect, type FileSystem } from "effect"
import { ageMillis, type AttentionItem, type DecidedItem, decidedItems, isOverdue, type OpenItem, openItems } from "./attention"
import { listTasks } from "./backlog"
import { type BacklogError, backlogPresent, noBacklog } from "./backlog-write"
import type { TaskFileError } from "./task-record"
import { formatTable } from "../table"

const ATTENTION_JSON_SCHEMA = "orc.attention.v1"

interface DecidedJson {
  readonly id: string
  readonly kind: AttentionItem["kind"]
  readonly task: string
  readonly text: string
  readonly asked: string
  readonly owner: AttentionItem["owner"]
  readonly decision: NonNullable<AttentionItem["decision"]>
  readonly answer: { readonly words: string; readonly at: string }
}

interface AttentionJson {
  readonly schema: typeof ATTENTION_JSON_SCHEMA
  readonly at: string
  readonly items: ReadonlyArray<Omit<AttentionItem, "state"> & { readonly id: string; readonly ageSeconds: number; readonly overdue: boolean }>
  readonly decided: ReadonlyArray<DecidedJson>
}

export const attentionJson = (items: ReadonlyArray<OpenItem>, at: string, decided: ReadonlyArray<DecidedItem> = []): AttentionJson => {
  const nowMillis = Date.parse(at)
  return {
    schema: ATTENTION_JSON_SCHEMA,
    at,
    items: items.map(({ id, item }) => ({
      id,
      kind: item.kind,
      task: item.task,
      text: item.text,
      asked: item.asked,
      owner: item.owner,
      ...(item.decision === undefined ? {} : { decision: item.decision }),
      ageSeconds: Math.floor(ageMillis(item, nowMillis) / 1000),
      overdue: isOverdue(item, nowMillis)
    })),
    decided: decided.flatMap(({ id, item }) => item.state.kind === "closed" && item.decision !== undefined ? [{
      id,
      kind: item.kind,
      task: item.task,
      text: item.text,
      asked: item.asked,
      owner: item.owner,
      decision: item.decision,
      answer: item.state.answer
    }] : [])
  }
}

const ageText = (seconds: number): string => {
  if (seconds < 60) {
    return seconds + "s"
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? minutes + "m" : Math.floor(minutes / 60) + "h" + String(minutes % 60).padStart(2, "0") + "m"
}

const formatAttention = (items: ReadonlyArray<OpenItem>, decided: ReadonlyArray<DecidedItem>, at: string): string => {
  const view = attentionJson(items, at, decided)
  const open = view.items.length > 0
    ? formatTable(
      ["ITEM", "KIND", "TASK", "OWNER", "AGE", "TEXT"],
      view.items.map((item) => [item.id, item.kind, item.task, item.owner, ageText(item.ageSeconds) + (item.overdue ? " overdue" : ""), item.text]),
      "nothing needs anyone"
    )
    : "nothing needs anyone"
  const answered = view.decided.map((entry) => "answered " + entry.id + ": " + entry.answer.words + " (" + entry.decision.reason + ")")
  return answered.length > 0 ? open + "\n\nDecided:\n" + answered.join("\n") : open
}

export const attentionText = (json: boolean, root: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (!json && !(yield* backlogPresent(root))) {
      return noBacklog(root)
    }
    const items = yield* openItems(root)
    const decided = yield* decidedItems(root, yield* listTasks(root))
    const at = DateTime.formatIso(yield* DateTime.now)
    return json ? JSON.stringify(attentionJson(items, at, decided)) : formatAttention(items, decided, at)
  })
