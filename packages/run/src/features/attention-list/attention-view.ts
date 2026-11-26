import { DateTime, Effect, type FileSystem } from "effect"
import { ageMillis, answerItem, type DecidedEntry, type Decision, decisionGroups, decisionText, type AttentionItem, type DecidedItem, isOverdue, type OpenItem, type OwnerDecision, readAttention } from "../../entities/attention/index"
import { listTasks, BacklogError, backlogPresent, noBacklog, type TaskFileError } from "../../entities/backlog/index"
import { deciderHeadings, deciderLabel, formatTable } from "../../shared/lib/index"

const ATTENTION_JSON_SCHEMA = "orc.attention.v1"

interface AttentionJson {
  readonly schema: typeof ATTENTION_JSON_SCHEMA
  readonly at: string
  readonly items: ReadonlyArray<Omit<AttentionItem, "state"> & { readonly id: string; readonly ageSeconds: number; readonly overdue: boolean }>
  readonly decided: ReadonlyArray<DecidedEntry>
}

export const attentionJson = (items: ReadonlyArray<OpenItem>, at: string, decided: ReadonlyArray<DecidedItem>): AttentionJson => {
  const nowMillis = Date.parse(at)
  return {
    schema: ATTENTION_JSON_SCHEMA,
    at,
    items: items.map(({ id, item }) => ({
      id,
      kind: item.kind,
      task: item.task,
      text: item.text,
      ...(item.subject === undefined ? {} : { subject: item.subject }),
      ...(item.options === undefined ? {} : { options: item.options }),
      ...(item.recommendation === undefined ? {} : { recommendation: item.recommendation }),
      asked: item.asked,
      owner: item.owner,
      ...(item.decision === undefined ? {} : { decision: item.decision }),
      ageSeconds: Math.floor(ageMillis(item, nowMillis) / 1000),
      overdue: isOverdue(item, nowMillis)
    })),
    decided: decided.flatMap(({ id, item }) => item.state.kind === "closed" ? [{
      id,
      kind: item.kind,
      task: item.task,
      text: item.text,
      asked: item.asked,
      owner: item.owner,
      ...(item.decision === undefined ? {} : { decision: item.decision }),
      answer: item.state.answer,
      ...(item.state.overturned === undefined ? {} : { overturned: item.state.overturned })
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

const openText = (item: { readonly text: string; readonly decision?: Decision }): string => {
  const text = item.text.replace(/\s+/g, " ").trim()
  return item.decision === undefined ? text : text + " (" + deciderLabel(item.decision.decider) + " · " + decisionText(item.decision) + ")"
}

const decidedLines = (line: OwnerDecision): string =>
  line.id + ": " + line.words + (line.replaced ? " (replaced)" : "") + (line.inferred ? " (attribution inferred)" : "") +
  "\n  question: " + line.question.replace(/\s+/g, " ").trim()

const formatAttention = (items: ReadonlyArray<OpenItem>, decided: ReadonlyArray<DecidedItem>, at: string): string => {
  const view = attentionJson(items, at, decided)
  const open = formatTable(
    ["ITEM", "KIND", "TASK", "OWNER", "AGE", "TEXT"],
    view.items.map((item) => [item.id, item.kind, item.task, item.owner, ageText(item.ageSeconds) + (item.overdue ? " overdue" : ""), openText(item)]),
    "nothing needs anyone"
  )
  const choices = view.items.filter((item) => item.subject !== undefined && item.options !== undefined && item.recommendation !== undefined)
    .map((item) => [
      item.id + ": " + item.subject,
      ...item.options?.map((option) => "- " + option.text + (option.outcome === undefined ? "" : ": " + option.outcome)) ?? [],
      "Recommended: " + (item.decision?.kind === "escalated" ? item.decision.recommendation ?? item.recommendation : item.recommendation)
    ].join("\n"))
  const groups = decisionGroups(view.decided)
  const sections = [
    ...(groups.owner.length === 0 ? [] : [deciderHeadings.owner + ":\n" + groups.owner.map(decidedLines).join("\n")]),
    ...(groups.agent.length === 0 ? [] : [deciderHeadings.agent + ":\n" + groups.agent.map((line) => decidedLines(line) + "\n  basis: " + line.basis).join("\n")])
  ]
  return [open, ...choices, ...sections].join("\n\n")
}

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
        return yield* new BacklogError({ detail: id + " closes when its task hold or question is answered, so run orc backlog answer " + outcome.task })
      }
    }
  })

export const attentionText = (json: boolean, root: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (!json && !(yield* backlogPresent(root))) {
      return noBacklog(root)
    }
    const snapshot = yield* readAttention(root, yield* listTasks(root))
    const at = DateTime.formatIso(yield* DateTime.now)
    return json ? JSON.stringify(attentionJson(snapshot.open, at, snapshot.decided)) : formatAttention(snapshot.open, snapshot.decided, at)
  })
