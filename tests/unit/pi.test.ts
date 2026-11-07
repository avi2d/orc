import { describe, expect, test } from "bun:test"
import type { AgentFile } from "../../packages/run/src/agents"
import { buildImplementPrompt, finalReplyError, orcCompletionLine, sessionPrintedSignal, sumPiUsage } from "../../packages/run/src/pi"

const agent = (tools: ReadonlyArray<string>): AgentFile => ({
  kind: "implementer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools,
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
})

describe("sumPiUsage", () => {
  test("adds input and output across usage lines and skips the rest", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 12247, output: 157, cacheRead: 753 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "session", id: "abc" })
    ].join("\n") + "\n"
    expect(sumPiUsage(jsonl)).toEqual({ input: 12247, output: 157 })
  })
  test("ignores blank lines, broken JSON and usage without numbers", () => {
    const jsonl = ["", "not json", JSON.stringify({ message: { usage: { input: "many" } } }), JSON.stringify({ message: { usage: { input: 3, output: 4 } } })].join("\n")
    expect(sumPiUsage(jsonl)).toEqual({ input: 3, output: 4 })
  })
  test("an empty session sums to zero", () => {
    expect(sumPiUsage("")).toEqual({ input: 0, output: 0 })
  })
})

const line = (entry: unknown): string => JSON.stringify(entry)
const text = (textBody: string): unknown => ({ type: "text", text: textBody })
const assistant = (content: ReadonlyArray<unknown>, stopReason: string, extra: Record<string, unknown> = {}): string =>
  line({ type: "message", message: { role: "assistant", content, stopReason, ...extra } })

describe("sessionPrintedSignal", () => {
  const promptText = "print " + orcCompletionLine + " on its own line and stop"
  const promptEcho = line({ type: "message", message: { role: "user", content: [text(promptText)] } })
  test("rejects a session where only the echoed prompt and thinking name the marker", () => {
    const jsonl = [
      promptEcho,
      assistant([{ type: "thinking", thinking: "the prompt wants " + orcCompletionLine }], "stop"),
      line({ type: "message", message: { role: "toolResult", content: [text("error: " + orcCompletionLine)] } })
    ].join("\n")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(false)
  })
  test("accepts the marker on its own line in a final reply that stopped cleanly", () => {
    const jsonl = [
      promptEcho,
      assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git commit -am work" } }], "toolUse"),
      assistant([{ type: "thinking", thinking: "done" }, text("Committed.\n" + orcCompletionLine)], "stop", { rawStopReason: "completed" })
    ].join("\n")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(true)
  })
  test("rejects a marker printed mid-run when the final reply is a provider error echoing the prompt", () => {
    const jsonl = [
      promptEcho,
      assistant([text("Plan:\n" + orcCompletionLine), { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git commit -am work" } }], "toolUse"),
      assistant([], "error", { errorMessage: "400 invalid request: " + promptText })
    ].join("\n")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(false)
  })
  test("rejects a marker the final reply mentions inside a sentence", () => {
    const jsonl = assistant([text("I will print " + orcCompletionLine + " once the tests pass.")], "stop")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(false)
  })
  test("rejects a final reply cut short by the length limit", () => {
    const jsonl = assistant([text(orcCompletionLine)], "length")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(false)
  })
  test("ignores blank lines and entries without assistant text", () => {
    expect(sessionPrintedSignal("", orcCompletionLine)).toBe(false)
    expect(sessionPrintedSignal("not json\n" + line({ type: "session", id: "x" }), orcCompletionLine)).toBe(false)
  })
})

describe("finalReplyError", () => {
  test("names the error a final reply ended in", () => {
    const jsonl = [
      assistant([], "error", { errorMessage: "opencode-go API error (503): 503 \"Service Unavailable\"" }),
      line({ type: "context_edit" })
    ].join("\n")
    expect(finalReplyError(jsonl)).toBe("opencode-go API error (503): 503 \"Service Unavailable\"")
  })
  test("names nothing for a reply that stopped cleanly after an earlier error", () => {
    const jsonl = [
      assistant([], "error", { errorMessage: "opencode-go API error (503): 503 \"Service Unavailable\"" }),
      assistant([text(orcCompletionLine)], "stop")
    ].join("\n")
    expect(finalReplyError(jsonl)).toBeNull()
  })
})

describe("buildImplementPrompt", () => {
  test("carries the instructions, the task file and the completion line", () => {
    const prompt = buildImplementPrompt(agent(["read"]), "/runs/abc/task.md")
    expect(prompt).toContain("Do the task.")
    expect(prompt).toContain("/runs/abc/task.md")
    expect(prompt).toContain(orcCompletionLine)
  })
})

