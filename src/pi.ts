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

const UsageTotals = Schema.Struct({ input: Schema.Number, output: Schema.Number })

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

