import { describe, expect, test } from "bun:test"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { piArgv, readPiLine, sessionFileName, stillRunningLines, toolLabel } from "../../packages/run/src/entities/agent/index"

const agent: AgentFile = { kind: "implementer", model: "acme/coder", thinking: "high", tools: ["read", "bash"], body: "", path: "a.md", source: "bundled" }

describe("piArgv", () => {
  test("passes the session folder and the resumed id as separate arguments, never through a shell", () => {
    expect(piArgv({ agent, instructions: "/r/instructions.md", sessionDir: "/r/sessions/host", resumeSession: "id; rm -rf ~" })).toEqual([
      "pi", "-p", "--mode", "json", "--model", "acme/coder", "--thinking", "high",
      "--session-dir", "/r/sessions/host", "--session", "id; rm -rf ~", "--tools", "read,bash", "--append-system-prompt", "/r/instructions.md"
    ])
  })

  test("leaves out --session and --append-system-prompt when there is nothing to resume or append", () => {
    expect(piArgv({ agent, instructions: null, sessionDir: "/s", resumeSession: null })).not.toContain("--session")
    expect(piArgv({ agent, instructions: null, sessionDir: "/s", resumeSession: null })).not.toContain("--append-system-prompt")
  })
})

describe("readPiLine", () => {
  test("names the session file the way Pi does, not with the raw colons of the timestamp", () => {
    expect(sessionFileName("0193", "2026-11-07T07:41:13.123Z")).toBe("2026-11-07T07-41-13-123Z_0193.jsonl")
    expect(readPiLine(JSON.stringify({ type: "session", version: 3, id: "0193", timestamp: "2026-11-07T07:41:13.123Z", cwd: "/c" }), "/s")).toEqual({
      kind: "session", id: "0193", file: "/s/2026-11-07T07-41-13-123Z_0193.jsonl"
    })
  })

  test("joins an assistant reply's text blocks and skips its tool calls and thinking", () => {
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Plan." }, { type: "toolCall", id: "c", name: "bash" }, { type: "text", text: "ORC_COMPLETE\n" }] } })
    expect(readPiLine(line, "/s")).toEqual({ kind: "reply", text: "Plan.\nORC_COMPLETE" })
  })

  test("does not log a user message or a tool result as the agent's reply", () => {
    expect(readPiLine(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "task" }] } }), "/s")).toEqual({ kind: "other" })
    expect(readPiLine(JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } }), "/s")).toEqual({ kind: "other" })
  })

  test("labels a bash tool by its command's first line and any other tool by its name", () => {
    expect(readPiLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "bun run test" } }), "/s")).toEqual({ kind: "tool-start", id: "c1", label: "bun run test", command: "bun run test" })
    expect(toolLabel("bash", { command: "cd a\nbun run lint" })).toBe("cd a …")
    expect(toolLabel("read", { path: "/x" })).toBe("read")
    expect(readPiLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false }), "/s")).toEqual({ kind: "tool-end", id: "c1", failed: false })
  })

  test("reads a tool end Pi marks isError as failed, instead of every tool end as a success", () => {
    expect(readPiLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true }), "/s")).toEqual({ kind: "tool-end", id: "c1", failed: true })
    expect(readPiLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/x" } }), "/s")).toEqual({ kind: "tool-start", id: "c2", label: "read", command: null })
  })

  test("reads a line that is not Pi JSON as other instead of failing the run", () => {
    expect(readPiLine("Warning: something", "/s")).toEqual({ kind: "other" })
    expect(readPiLine("", "/s")).toEqual({ kind: "other" })
  })
})

describe("stillRunningLines", () => {
  test("reports a tool in whole minutes once it has run one, and stays quiet before that", () => {
    const since = 1_000_000
    expect(stillRunningLines([{ label: "bun run test", since }], since + 59_999)).toEqual([])
    expect(stillRunningLines([{ label: "bun run test", since }, { label: "bun run lint", since: since + 60_000 }], since + 3 * 60_000 + 5)).toEqual([
      "still running bun run test (3 min)",
      "still running bun run lint (2 min)"
    ])
  })
})
