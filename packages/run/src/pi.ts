import { pi, type AgentCommandOptions, type AgentProvider } from "@ai-hero/sandcastle"
import { Option, Schema } from "effect"
import type { AgentFile } from "./agents"

export const orcCompletionLine = "ORC_COMPLETE"

export interface PiSessionDirs {
  readonly hostSessionsDir: string
  readonly sandboxSessionsDir: string
}

const shellEscape = (arg: string): string => "'" + arg.replace(/'/g, "'\\''") + "'"

export const toolFlag = (agent: AgentFile): string => " --tools " + shellEscape(agent.tools.join(","))

export const piWithTools = (agent: AgentFile, sessions: PiSessionDirs): AgentProvider => {
  const base = pi(agent.model, {
    thinking: agent.thinking,
    sessionStorage: { hostSessionsDir: sessions.hostSessionsDir, sandboxSessionsDir: sessions.sandboxSessionsDir }
  })
  return {
    ...base,
    buildPrintCommand: (options: AgentCommandOptions) => {
      const command = base.buildPrintCommand(options)
      return { ...command, command: command.command + toolFlag(agent) }
    }
  }
}

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

// Sandcastle matches the completion marker anywhere in the agent output, including a Pi error payload that echoes the prompt back. Only a cleanly stopped final reply counts.
export const sessionPrintedSignal = (jsonl: string, signal: string): boolean => {
  const final = finalAssistantMessage(jsonl)
  return final !== undefined &&
    final.stopReason === "stop" &&
    final.content.some((block) => block.type === "text" && printsOnOwnLine(block.text ?? "", signal))
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

export const buildImplementPrompt = (agent: AgentFile, taskFile: string): string =>
  [
    agent.body,
    "",
    "The task sits in " + taskFile + ". Read that file and implement what it asks. When the work is committed on this branch, print " + orcCompletionLine + " on its own line and stop."
  ].join("\n")

