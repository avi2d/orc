import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentFile } from "../../src/agents"
import { buildImplementPrompt, orcCompletionLine, piWithTools, sessionPrintedSignal, sumPiUsage, toolFlag } from "../../src/pi"

const q = String.fromCharCode(39)
const backslash = String.fromCharCode(92)

const agent = (tools: ReadonlyArray<string>): AgentFile => ({
  kind: "implementer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools,
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
})

describe("toolFlag", () => {
  test("joins the tools into one quoted flag value", () => {
    expect(toolFlag(agent(["read", "bash", "edit", "write"]))).toBe(" --tools " + q + "read,bash,edit,write" + q)
  })
  test("escapes a quote inside a tool name for POSIX shells", () => {
    expect(toolFlag(agent(["a" + q + "b"]))).toBe(" --tools " + q + "a" + q + backslash + q + q + "b" + q)
  })
})

describe("piWithTools", () => {
  test("the print command names the model, the thinking level and only the listed tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-pi-"))
    try {
      const provider = piWithTools(agent(["read", "bash"]), {
        hostSessionsDir: join(root, "host"),
        sandboxSessionsDir: join(root, "sandbox")
      })
      const command = provider.buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: true })
      expect(command.command).toContain("opencode-go/muse-spark")
      expect(command.command).toContain("--thinking high")
      expect(command.command).toContain("--tools " + q + "read,bash" + q)
      expect(command.command).not.toContain("edit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
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

describe("sessionPrintedSignal", () => {
  const line = (entry: unknown): string => JSON.stringify(entry)
  const text = (textBody: string): unknown => ({ type: "text", text: textBody })
  const assistant = (content: ReadonlyArray<unknown>): string =>
    line({ type: "message", message: { role: "assistant", content } })
  const promptEcho = line({
    type: "message",
    message: { role: "user", content: [text("print " + orcCompletionLine + " on its own line and stop")] }
  })
  test("rejects a session where only the echoed prompt and thinking name the marker", () => {
    const jsonl = [
      promptEcho,
      assistant([{ type: "thinking", thinking: "the prompt wants " + orcCompletionLine }]),
      line({ type: "message", message: { role: "toolResult", content: [text("error: " + orcCompletionLine)] } })
    ].join("\n")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(false)
  })
  test("accepts the marker in agent text beside thinking blocks", () => {
    const jsonl = [
      promptEcho,
      assistant([{ type: "thinking", thinking: "done" }, text("Committed.\n" + orcCompletionLine)])
    ].join("\n")
    expect(sessionPrintedSignal(jsonl, orcCompletionLine)).toBe(true)
  })
  test("ignores blank lines and entries without assistant text", () => {
    expect(sessionPrintedSignal("", orcCompletionLine)).toBe(false)
    expect(sessionPrintedSignal("not json\n" + line({ type: "session", id: "x" }), orcCompletionLine)).toBe(false)
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

