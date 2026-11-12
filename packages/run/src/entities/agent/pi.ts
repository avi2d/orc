import { Option, Schema } from "effect"
import type { AgentFile } from "./agents"
import { childBudget, splitJsonSchema } from "../backlog/index"

export const orcCompletionLine = "ORC_COMPLETE"
export const orcSplitLine = "ORC_SPLIT"

const UsageTotals = Schema.Struct({ input: Schema.Finite, output: Schema.Finite })

export type PiTokenUse = typeof UsageTotals.Type

const noUsage: PiTokenUse = { input: 0, output: 0 }

// Pi nests token counts inside the message payload, beside role and content.
const UsageLine = Schema.Struct({ message: Schema.Struct({ usage: Schema.optional(UsageTotals) }) })

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(UsageLine))

const usageOf = (line: string): PiTokenUse =>
  Option.match(decodeLine(line), {
    onNone: () => noUsage,
    onSome: (entry) => entry.message.usage ?? noUsage
  })

const TextBlock = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })

const AssistantLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
    content: Schema.Array(TextBlock)
  })
})

const decodeAssistantLine = Schema.decodeUnknownOption(Schema.fromJsonString(AssistantLine))

const finalAssistantMessage = (jsonl: string) =>
  jsonl.split("\n").flatMap((line) => Option.toArray(decodeAssistantLine(line))).at(-1)?.message

const printsOnOwnLine = (text: string, signal: string): boolean =>
  text.split("\n").some((line) => line.trim() === signal)

// A Pi error payload can echo the prompt, marker included, so only a cleanly stopped final reply counts.
export const sessionPrintedSignal = (jsonl: string, signal: string): boolean => {
  const final = finalAssistantMessage(jsonl)
  return final !== undefined &&
    final.stopReason === "stop" &&
    final.content.some((block) => block.type === "text" && printsOnOwnLine(block.text ?? "", signal))
}

export const finalReplyText = (jsonl: string): string | null => {
  const final = finalAssistantMessage(jsonl)
  return final?.stopReason === "stop" ? final.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") : null
}

export const finalReplyError = (jsonl: string): string | null => {
  const final = finalAssistantMessage(jsonl)
  if (final === undefined || final.stopReason !== "error") {
    return null
  }
  return final.errorMessage ?? "an unnamed error"
}

export const sumPiUsage = (jsonl: string): PiTokenUse => {
  let input = 0
  let output = 0
  for (const line of jsonl.split("\n")) {
    const usage = usageOf(line)
    input += usage.input
    output += usage.output
  }
  return { input, output }
}

const taskLine = (taskFile: string, scope: string): string =>
  "The task sits in " + taskFile + ". Read that file and implement " + scope + ". When the work is committed on this branch, print " + orcCompletionLine + " on its own line and stop."

const splitLines = (): string =>
  [
    "The budget is " + childBudget + ". If the change outgrows it, stop without opening a PR. Print " + orcSplitLine + " on its own line followed by a JSON document matching this schema.",
    "Split JSON schema: " + splitJsonSchema,
    "Each vertical slice must be useful, testable and observable alone, with one small PR merging to main on its own.",
    "Titles are single-line nonblank strings. Reason explains the budget overrun. Bodies describe the slice change and its check. Done lists the whole-task criteria, each a nonblank string."
  ].join("\n")

export const implementInstructions = (taskFile: string, scope: string): string =>
  taskLine(taskFile, scope) + "\n" + splitLines()

export const buildImplementPrompt = (agent: AgentFile, taskFile: string): string =>
  [
    agent.body,
    "",
    implementInstructions(taskFile, "what it asks")
  ].join("\n")

export const textAfterSignal = (text: string, signal: string): string => {
  const lines = text.split("\n")
  const index = lines.findIndex((line) => line.trim() === signal)
  return index === -1 ? "" : lines.slice(index + 1).join("\n")
}

