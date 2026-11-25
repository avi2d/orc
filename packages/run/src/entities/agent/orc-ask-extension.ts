import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// orc copies this file into the run's session folder for Pi to load inside the sandbox, so it imports node built-ins only.

export const askToolName = "orc_ask"
export const askDirFlag = "orc-ask-dir"
export const replySuffix = ".reply.json"
const askSuffix = ".ask.json"
const deliveredSuffix = ".delivered"
const pollMillis = 1000

const askFileStem = (toolCallId: string): string => toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")

export type AskReply =
  | { readonly kind: "answer" | "correction"; readonly id: string; readonly question: string; readonly words: string }
  | { readonly kind: "timeout"; readonly id: string }

interface TextBlock {
  readonly type: "text"
  readonly text: string
}

interface AskToolResult {
  readonly content: ReadonlyArray<TextBlock>
  readonly details: undefined
}

interface AskTool {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: unknown
  readonly execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<AskToolResult>
}

interface ToolResultEvent {
  readonly content: ReadonlyArray<unknown>
}

interface AskHost {
  readonly registerFlag: (name: string, options: { readonly description: string; readonly type: "string" }) => void
  readonly getFlag: (name: string) => unknown
  readonly registerTool: (tool: AskTool) => void
  readonly on: (event: "tool_result", handler: (event: ToolResultEvent) => { readonly content: ReadonlyArray<unknown> } | undefined) => void
}

const isAskReply = (value: unknown): value is AskReply => {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || !("kind" in value)) {
    return false
  }
  if (value.kind === "timeout") {
    return true
  }
  return (value.kind === "answer" || value.kind === "correction") && "question" in value && typeof value.question === "string" && "words" in value && typeof value.words === "string"
}

const readReply = (dir: string, stem: string): AskReply | null => {
  const file = join(dir, stem + replySuffix)
  if (!existsSync(file)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isAskReply(parsed) ? parsed : null
  } catch {
    return null
  }
}

const markDelivered = (dir: string, stem: string): void => {
  writeFileSync(join(dir, stem + deliveredSuffix), "")
}

const questionNamed = (reply: { readonly id: string; readonly question: string }): string =>
  reply.id + (reply.question === "" ? "" : " (" + reply.question + ")")

const replyText = (reply: AskReply): string => {
  switch (reply.kind) {
    case "answer": {
      return "The captain answered your question " + questionNamed(reply) + ": " + reply.words
    }
    case "correction": {
      return "The captain replaced the answer you got to your question " + questionNamed(reply) + ". Work from this answer instead: " + reply.words
    }
    case "timeout": {
      return "No answer to " + reply.id + " came in time. orc stops this session now and resumes it with the captain's answer, so do nothing more."
    }
  }
}

const textResult = (text: string): AskToolResult => ({ content: [{ type: "text", text }], details: undefined })

const pause = (millis: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, millis)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

// orc owns the deadline and writes the timeout reply when it passes, so this wait ends only on a reply or an abort.
const waitForReply = async (dir: string, stem: string, signal: AbortSignal | undefined): Promise<AskReply> => {
  for (;;) {
    const reply = readReply(dir, stem)
    if (reply !== null) {
      return reply
    }
    if (signal?.aborted === true) {
      throw new Error("the wait for the captain's answer was stopped")
    }
    await pause(pollMillis, signal)
  }
}

const undeliveredAnswers = (dir: string, waiting: ReadonlySet<string>): ReadonlyArray<string> => {
  const names = existsSync(dir) ? readdirSync(dir) : []
  return names
    .filter((name) => name.endsWith(replySuffix))
    .map((name) => name.slice(0, -replySuffix.length))
    .filter((stem) => !waiting.has(stem) && !names.includes(stem + deliveredSuffix))
    .toSorted()
    .flatMap((stem) => {
      const reply = readReply(dir, stem)
      if (reply === null || reply.kind === "timeout") {
        return []
      }
      markDelivered(dir, stem)
      return [replyText(reply)]
    })
}

const parameters = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question, in one or two sentences the captain can answer without reading the code" },
    context: { type: "string", description: "What you found that makes the question come up" },
    options: {
      type: "array",
      description: "The answers you see; orc letters them A, B, C in this order",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "What this option means" },
          outcome: { type: "string", description: "What choosing this option leads to" },
          picture: { type: "string", description: "A path to a picture that shows this option" }
        },
        required: ["text", "outcome"]
      }
    },
    recommendation: { type: "string", description: "The text of the option you recommend, exactly as it appears in options" },
    blocks: { type: "boolean", description: "true when you cannot go on without the answer, false when you can carry on and take the answer later" }
  },
  required: ["question", "options", "recommendation", "blocks"]
}

const description = [
  "Ask the captain a question when the decision is theirs and a guess could waste the run.",
  "With blocks true the tool waits up to 10 minutes and returns the answer; when none comes, orc stops you and later resumes this session with the answer.",
  "With blocks false the tool returns at once, and the answer is added to the result of a later tool call."
].join(" ")

interface AskOptionParams {
  readonly text: string
  readonly outcome: string
  readonly picture?: string | undefined
}

interface AskParams {
  readonly question: string
  readonly context?: string | undefined
  readonly options: ReadonlyArray<AskOptionParams>
  readonly recommendation: string
  readonly blocks: boolean
}

const isAskRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const trimmed = (value: unknown): string => typeof value === "string" ? value.trim() : ""

const askOption = (item: unknown, index: number): AskOptionParams | string => {
  if (!isAskRecord(item) || trimmed(item.text) === "") {
    return "option " + String(index + 1) + " has no text"
  }
  const text = trimmed(item.text)
  const outcome = trimmed(item.outcome)
  if (outcome === "") {
    return "option " + JSON.stringify(text) + " has no outcome"
  }
  const picture = trimmed(item.picture)
  return { text, outcome, ...(picture === "" ? {} : { picture }) }
}

const normalizeAsk = (params: unknown): AskParams | string => {
  if (!isAskRecord(params) || trimmed(params.question) === "" || typeof params.blocks !== "boolean") {
    return "it has no question or no blocks"
  }
  if (!Array.isArray(params.options) || params.options.length === 0) {
    return "it lists no options"
  }
  const options: Array<AskOptionParams> = []
  for (const [index, item] of params.options.entries()) {
    const option = askOption(item, index)
    if (typeof option === "string") {
      return option
    }
    options.push(option)
  }
  const recommendation = trimmed(params.recommendation)
  if (!options.some((option) => option.text === recommendation)) {
    return "the recommendation " + JSON.stringify(recommendation) + " names none of the listed options"
  }
  const context = trimmed(params.context)
  return {
    question: trimmed(params.question),
    blocks: params.blocks,
    ...(context === "" ? {} : { context }),
    options,
    recommendation
  }
}

export default (pi: AskHost): void => {
  pi.registerFlag(askDirFlag, { description: "The folder orc and the orc_ask tool trade questions and answers through", type: "string" })
  const waiting = new Set<string>()
  const askDir = (): string | null => {
    const dir = pi.getFlag(askDirFlag)
    return typeof dir === "string" && dir !== "" ? dir : null
  }
  pi.registerTool({
    name: askToolName,
    label: "Ask the captain",
    description,
    parameters,
    execute: async (toolCallId, params, signal) => {
      const dir = askDir()
      if (dir === null) {
        throw new Error("Pi started without --" + askDirFlag + ", so no one can answer")
      }
      const normalized = normalizeAsk(params)
      if (typeof normalized === "string") {
        return textResult("orc did not ask the question, because " + normalized + ". Each option needs text and an outcome, and the recommendation must repeat one option's text. Ask again with that fixed.")
      }
      const stem = askFileStem(toolCallId)
      writeFileSync(join(dir, stem + askSuffix), JSON.stringify(normalized))
      if (!normalized.blocks) {
        return textResult("orc put the question to the captain. Carry on with the task; the answer is added to the result of a later tool call.")
      }
      waiting.add(stem)
      try {
        const reply = await waitForReply(dir, stem, signal)
        markDelivered(dir, stem)
        return textResult(replyText(reply))
      } finally {
        waiting.delete(stem)
      }
    }
  })
  pi.on("tool_result", (event) => {
    const dir = askDir()
    const answers = dir === null ? [] : undeliveredAnswers(dir, waiting)
    return answers.length === 0 ? undefined : { content: [...event.content, ...answers.map((text): TextBlock => ({ type: "text", text }))] }
  })
}
