import { Option, Schema } from "effect"
import type { AgentFile } from "./agents"
import { orcCompletionLine } from "./pi"

export const longSessionTurnLimit = 300
export const longSessionCompactionLimit = 5

export const handoverFileName = "handover.md"

export const inheritedHandoverFileName = "inherited-handover.md"

export const handoverLastReplyLimit = 2000

const longSessionName = "long-session"

export interface LongSessionCounts {
  readonly turns: number
  readonly compactions: number
}

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const countSessionSize = (jsonl: string): LongSessionCounts => {
  let turns = 0
  let compactions = 0
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") {
      continue
    }
    const parsed = decodeJsonLine(line)
    if (Option.isNone(parsed) || !isRecord(parsed.value)) {
      continue
    }
    const record = parsed.value
    if (record["type"] === "compaction") {
      compactions += 1
      continue
    }
    if (record["type"] !== "message" || !isRecord(record["message"])) {
      continue
    }
    const role = record["message"]["role"]
    if (role === "user" || role === "assistant") {
      turns += 1
    }
  }
  return { turns, compactions }
}

export const longSessionWarning = (counts: LongSessionCounts): string | null => {
  const overTurns = counts.turns >= longSessionTurnLimit
  const overCompactions = counts.compactions >= longSessionCompactionLimit
  if (!overTurns && !overCompactions) {
    return null
  }
  const cause = overTurns && overCompactions
    ? counts.turns.toString() + " turns and " + counts.compactions.toString() + " compactions"
    : overTurns
      ? counts.turns.toString() + " turns"
      : counts.compactions.toString() + " compactions"
  return "orc: the session reached " + cause + " (limits " + longSessionTurnLimit.toString() + " turns, " + longSessionCompactionLimit.toString() + " compactions), so continue from " + handoverFileName + " in a fresh run"
}

export const longSessionSignal = (counts: LongSessionCounts | null): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  if (counts === null) {
    return []
  }
  const warning = longSessionWarning(counts)
  return warning === null ? [] : [{ name: longSessionName, value: warning }]
}

const AssistantReplyLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
  })
})

const decodeAssistantReplyLine = Schema.decodeUnknownOption(Schema.fromJsonString(AssistantReplyLine))

export const lastAssistantReply = (jsonl: string | null): string | null => {
  if (jsonl === null) {
    return null
  }
  let found: string | null = null
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") {
      continue
    }
    const parsed = decodeAssistantReplyLine(line)
    if (Option.isNone(parsed)) {
      continue
    }
    const text = parsed.value.message.content.filter((block) => block.type === "text" && (block.text ?? "") !== "").map((block) => block.text ?? "").join("\n")
    if (text !== "") {
      found = text
    }
  }
  if (found === null) {
    return null
  }
  return found.length > handoverLastReplyLimit ? found.slice(0, handoverLastReplyLimit) : found
}

export const handoverNote = (input: {
  readonly runId: string
  readonly branch: string
  readonly counts: LongSessionCounts
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly subject: string }>
  readonly taskText: string
  readonly lastReply: string | null
  readonly endReason: string
}): string => {
  const did = input.commits.length === 0
    ? "Made no commit."
    : input.commits.map((commit) => "- " + commit.sha + (commit.subject === "" ? "" : " " + commit.subject)).join("\n")
  const task = input.taskText.trim() === "" ? "Task text unavailable." : input.taskText.trim()
  const reply = input.lastReply === null || input.lastReply.trim() === "" ? "No assistant reply captured." : input.lastReply
  return [
    "# Handover " + input.runId,
    "",
    "Branch: " + input.branch,
    "Session: " + input.counts.turns.toString() + " turns, " + input.counts.compactions.toString() + " compactions.",
    "",
    "## What this run did",
    "",
    did,
    "",
    "## What is left",
    "",
    "Task:",
    "",
    task,
    "",
    "Commits so far:",
    "",
    did,
    "",
    "Last reply:",
    "",
    reply,
    "",
    "Compare the task text above with the commits to find what is left.",
    "Stop reason: " + input.endReason,
    "",
    "## Where it stopped",
    "",
    "Branch " + input.branch + " in run " + input.runId + ". Continue from this note."
  ].join("\n") + "\n"
}

export const handoverImplementPrompt = (agent: AgentFile, taskFile: string, note: string): string =>
  [
    agent.body,
    "",
    "The previous run left this handover note. Read it and continue from where it stopped:",
    "",
    note.trimEnd(),
    "",
    "The task sits in " + taskFile + ". Read that file and implement what the note leaves undone. When the work is committed on this branch, print " + orcCompletionLine + " on its own line and stop."
  ].join("\n")
