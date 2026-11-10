import { DateTime, Effect, type FileSystem } from "effect"
import { ageMillis, answerItem, type AttentionItem, isOverdue, type OpenItem, openItems } from "./attention"
import { BacklogError, backlogPresent, noBacklog } from "./backlog-write"
import { formatTable } from "../table"

const ATTENTION_JSON_SCHEMA = "orc.attention.v1"

interface AttentionJson {
  readonly schema: typeof ATTENTION_JSON_SCHEMA
  readonly at: string
  readonly items: ReadonlyArray<Omit<AttentionItem, "state"> & { readonly id: string; readonly ageSeconds: number; readonly overdue: boolean }>
}

export const attentionJson = (items: ReadonlyArray<OpenItem>, at: string): AttentionJson => {
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
      ageSeconds: Math.floor(ageMillis(item, nowMillis) / 1000),
      overdue: isOverdue(item, nowMillis)
    }))
  }
}

const ageText = (seconds: number): string => {
  if (seconds < 60) {
    return seconds + "s"
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? minutes + "m" : Math.floor(minutes / 60) + "h" + String(minutes % 60).padStart(2, "0") + "m"
}

const formatAttention = (items: ReadonlyArray<OpenItem>, at: string): string =>
  formatTable(
    ["ITEM", "KIND", "TASK", "OWNER", "AGE", "TEXT"],
    attentionJson(items, at).items.map((item) => [item.id, item.kind, item.task, item.owner, ageText(item.ageSeconds) + (item.overdue ? " overdue" : ""), item.text]),
    "nothing needs anyone"
  )

export const answerItemText = (root: string, id: string, answer: { readonly words: string; readonly at: string }): Effect.Effect<string, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const outcome = yield* answerItem(root, id, answer)
    switch (outcome) {
      case "closed": {
        return "answered " + id
      }
      case "already closed": {
        return yield* new BacklogError({ detail: id + " is no longer open" })
      }
      case "missing": {
        return yield* new BacklogError({ detail: "the attention queue holds no " + id })
      }
      default: {
        return yield* new BacklogError({ detail: id + " closes when its task's question is answered, so run orc backlog answer " + outcome.task })
      }
    }
  })

export const attentionText = (json: boolean, root: string): Effect.Effect<string, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (!json && !(yield* backlogPresent(root))) {
      return noBacklog(root)
    }
    const items = yield* openItems(root)
    const at = DateTime.formatIso(yield* DateTime.now)
    return json ? JSON.stringify(attentionJson(items, at)) : formatAttention(items, at)
  })
