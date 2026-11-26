import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import registerAsk, { askDirFlag, askToolName, replySuffix } from "../../packages/run/src/entities/agent/orc-ask-extension"
import * as workerAsk from "../../packages/run/src/entities/agent/worker-ask"

interface Registered {
  readonly execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>
}

type ToolResultHandler = (event: { readonly content: ReadonlyArray<unknown> }) => { readonly content: ReadonlyArray<unknown> } | undefined

const loadAsk = (dir: string): { readonly tool: Registered; readonly afterTool: ToolResultHandler } => {
  const tools = new Map<string, Registered>()
  const handlers: Array<ToolResultHandler | undefined> = []
  registerAsk({
    registerFlag: () => undefined,
    getFlag: (name) => name === askDirFlag ? dir : undefined,
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (_event, handler) => handlers.push(handler)
  }, 10)
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

const colour = { question: "Which colour?", options: [{ text: "Red", outcome: "The page turns red" }, { text: "Blue", outcome: "The page turns blue" }], recommendation: "Red" }

const texts = (result: { readonly content: ReadonlyArray<unknown> } | undefined): ReadonlyArray<unknown> =>
  (result?.content ?? []).map((block) => typeof block === "object" && block !== null && "text" in block ? block.text : block)

describe("the orc_ask tool inside Pi", () => {
  test("orc launches pi with the tool name and flag the extension registers, instead of names that drifted apart", () => {
    expect([workerAsk.askToolName, workerAsk.askDirFlag]).toEqual([askToolName, askDirFlag])
  })

  test("a blocking ask answered within the wait returns the answer as its own result, instead of returning before the answer", async () => {
    await withAskDir(async (dir) => {
      const { tool } = loadAsk(dir)
      let settled = false
      const pending = tool.execute("call-1", { ...colour, blocks: true }).then((result) => {
        settled = true
        return result
      })
      await new Promise((resolve) => setImmediate(resolve))
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
      const result = await tool.execute("call-1", { ...colour, blocks: false })
      expect(Date.now() - started).toBeLessThan(500)
      expect(result.content.map((block) => block.text).join("")).toContain("Carry on with the task")
      expect(afterTool({ content: [{ type: "text", text: "ls output" }] })).toBeUndefined()
      await reply(dir, "call-1", "B")
      expect(texts(afterTool({ content: [{ type: "text", text: "ls output" }] }))).toEqual(["ls output", "The captain answered your question ask-1 (Which colour?): B"])
      expect(afterTool({ content: [{ type: "text", text: "ls output" }] })).toBeUndefined()
    })
  })

  test("a blocking ask writes its validated question to an ask file instead of relying on the raw tool args", async () => {
    await withAskDir(async (dir) => {
      const { tool } = loadAsk(dir)
      const pending = tool.execute("call-7", { question: "  Which colour? ", context: "  ", options: [{ text: "  Red ", outcome: " The page turns red ", picture: " " }], recommendation: " Red ", blocks: true, extra: "dropped" })
      const stored = JSON.parse(await readFile(join(dir, "call-7.ask.json"), "utf8"))
      expect(stored).toEqual({ question: "Which colour?", blocks: true, options: [{ text: "Red", outcome: "The page turns red" }], recommendation: "Red" })
      await reply(dir, "call-7", "B")
      await pending
    })
  }, 10_000)

  test("a question orc cannot read is never asked instead of stalling the tool", async () => {
    await withAskDir(async (dir) => {
      const { tool } = loadAsk(dir)
      const result = await tool.execute("call-9", { question: "   ", blocks: true })
      expect(result.content.map((block) => block.text).join("")).toContain("did not ask the question")
      expect(await readdir(dir)).toEqual([])
    })
  })

  test("an option without an outcome is refused and never asked, instead of reaching the captain without what it leads to", async () => {
    await withAskDir(async (dir) => {
      const { tool } = loadAsk(dir)
      const result = await tool.execute("call-3", { ...colour, options: [{ text: "Red", outcome: "The page turns red" }, { text: "Blue", outcome: "  " }], blocks: true })
      expect(result.content.map((block) => block.text).join("")).toContain("option \"Blue\" has no outcome")
      expect(await readdir(dir)).toEqual([])
    })
  })

  test("a recommendation that names no listed option is refused and never asked, instead of reaching the captain without a pick", async () => {
    await withAskDir(async (dir) => {
      const { tool } = loadAsk(dir)
      const missing = await tool.execute("call-4", { ...colour, recommendation: "Green", blocks: true })
      expect(missing.content.map((block) => block.text).join("")).toContain("the recommendation \"Green\" names none of the listed options")
      const absent = await tool.execute("call-5", { question: "Which colour?", options: colour.options, blocks: true })
      expect(absent.content.map((block) => block.text).join("")).toContain("names none of the listed options")
      expect(await readdir(dir)).toEqual([])
    })
  })

  test("a blocking ask's own answer is not also added to a later tool result", async () => {
    await withAskDir(async (dir) => {
      const { tool, afterTool } = loadAsk(dir)
      const pending = tool.execute("call-1", { ...colour, blocks: true })
      await reply(dir, "call-1", "B")
      await pending
      expect(afterTool({ content: [] })).toBeUndefined()
    })
  }, 10_000)

  test("a correction to an answer already delivered joins the next tool result as a replacement once, instead of being dropped or read as a second answer", async () => {
    await withAskDir(async (dir) => {
      const { tool, afterTool } = loadAsk(dir)
      const pending = tool.execute("call-1", { ...colour, blocks: true })
      await reply(dir, "call-1", "B")
      await pending
      await writeFile(join(dir, "correction-ask-1-1" + replySuffix), JSON.stringify({ kind: "correction", id: "ask-1", question: "Which colour?", words: "R" }))
      expect(texts(afterTool({ content: [{ type: "text", text: "ls output" }] }))).toEqual([
        "ls output",
        "The captain replaced the answer you got to your question ask-1 (Which colour?). Work from this answer instead: R"
      ])
      expect(afterTool({ content: [] })).toBeUndefined()
    })
  }, 10_000)
})
