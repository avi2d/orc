import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import registerAsk, { askDirFlag, askToolName, replySuffix } from "../../packages/run/src/entities/agent/orc-ask-extension"

interface Registered {
  readonly execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>
}

type ToolResultHandler = (event: { readonly content: ReadonlyArray<unknown> }) => { readonly content: ReadonlyArray<unknown> } | undefined

const loadAsk = (dir: string): { readonly tool: Registered; readonly afterTool: ToolResultHandler } => {
  const tools = new Map<string, Registered>()
  const handlers: Array<ToolResultHandler> = []
  registerAsk({
    registerFlag: () => undefined,
    getFlag: (name) => name === askDirFlag ? dir : undefined,
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (_event, handler) => handlers.push(handler)
  })
  const tool = tools.get(askToolName)
  const afterTool = handlers[0]
  if (tool === undefined || afterTool === undefined) {
    throw new Error("the extension registered no orc_ask tool or no tool_result handler")
  }
  return { tool, afterTool }
}

const withAskDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-ask-"))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const reply = (dir: string, stem: string, words: string): Promise<void> =>
  writeFile(join(dir, stem + replySuffix), JSON.stringify({ kind: "answer", id: "ask-1", question: "Which colour?", words }))

const texts = (result: { readonly content: ReadonlyArray<unknown> } | undefined): ReadonlyArray<unknown> =>
  (result?.content ?? []).map((block) => typeof block === "object" && block !== null && "text" in block ? block.text : block)

describe("the orc_ask tool inside Pi", () => {
  test("a blocking ask answered within the wait returns the answer as its own result, instead of returning before the answer", async () => {
    await withAskDir(async (dir) => {
      const { tool } = loadAsk(dir)
      let settled = false
      const pending = tool.execute("call-1", { question: "Which colour?", blocks: true }).then((result) => {
        settled = true
        return result
      })
      await Bun.sleep(1500)
      expect(settled).toBe(false)
      await reply(dir, "call-1", "B")
      const result = await pending
      expect(result.content.map((block) => block.text)).toEqual(["The captain answered your question ask-1 (Which colour?): B"])
    })
  }, 10_000)

  test("a non-blocking ask returns at once and its answer joins the next tool result once, instead of waiting or repeating it", async () => {
    await withAskDir(async (dir) => {
      const { tool, afterTool } = loadAsk(dir)
      const started = Date.now()
      const result = await tool.execute("call-1", { question: "Which colour?", blocks: false })
      expect(Date.now() - started).toBeLessThan(500)
      expect(result.content.map((block) => block.text).join("")).toContain("Carry on with the task")
      expect(afterTool({ content: [{ type: "text", text: "ls output" }] })).toBeUndefined()
      await reply(dir, "call-1", "B")
      expect(texts(afterTool({ content: [{ type: "text", text: "ls output" }] }))).toEqual(["ls output", "The captain answered your question ask-1 (Which colour?): B"])
      expect(afterTool({ content: [{ type: "text", text: "ls output" }] })).toBeUndefined()
    })
  })

  test("a blocking ask's own answer is not also added to a later tool result", async () => {
    await withAskDir(async (dir) => {
      const { tool, afterTool } = loadAsk(dir)
      const pending = tool.execute("call-1", { question: "Which colour?", blocks: true })
      await reply(dir, "call-1", "B")
      await pending
      expect(afterTool({ content: [] })).toBeUndefined()
    })
  }, 10_000)
})
