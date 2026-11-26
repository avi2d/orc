import { describe, expect, test } from "bun:test"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { listRuns, openDatabase, openQuestionsForRun } from "../../packages/run/src/entities/run-history/index"
import { type NoSandboxFixture, runOrc, withNoSandboxFixture, writeScript } from "./no-sandbox-fixture"

const sessionId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d"

const options = [{ text: "Keep the old flag" }, { text: "Drop the old flag", picture: "docs/flag.png" }]

const askEvent = (blocks: boolean): string =>
  JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "orc_ask", args: { question: "Keep the old flag?", context: "Two callers still pass it.", options, blocks } })

const askFile = (blocks: boolean): string =>
  JSON.stringify({ question: "Keep the old flag?", blocks, context: "Two callers still pass it.", options })

const askingPi = async (fixture: NoSandboxFixture, blocks: boolean): Promise<void> => {
  const bin = fixture.fakeBin
  await writeFile(join(bin, "header.jsonl"), JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-28T10:00:00.000Z", cwd: "/repo" }) + "\n")
  await writeScript(join(bin, "pi"), [
    "if [ \"$1\" = auth ]; then exit 0; fi",
    "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '{\"id\":\"orc-models\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{\"models\":[{\"provider\":\"acme-go\",\"id\":\"coder-1\",\"contextWindow\":262144}]}}'; exit 0; fi",
    "if [ -f \"" + bin + "/pi-runs\" ]; then echo \"$*\" > \"" + bin + "/resumed-argv\"; cat > \"" + bin + "/resumed-prompt\"; echo ran >> \"" + bin + "/pi-runs\"; exit 1; fi",
    "cat > /dev/null",
    "echo ran >> \"" + bin + "/pi-runs\"",
    "echo \"$*\" > \"" + bin + "/first-argv\"",
    "prev=''; for arg in \"$@\"; do if [ \"$prev\" = --session-dir ]; then session_dir=$arg; fi; if [ \"$prev\" = --orc-ask-dir ]; then ask_dir=$arg; fi; if [ \"$prev\" = --extension ]; then extension=$arg; fi; prev=$arg; done",
    "cp \"$extension\" \"" + bin + "/extension-copy\"",
    "mkdir -p \"$session_dir\"",
    "cp \"" + bin + "/header.jsonl\" \"$session_dir/2026-10-28T10-00-00-000Z_" + sessionId + ".jsonl\"",
    "cat \"" + bin + "/header.jsonl\"",
    "echo '" + askEvent(blocks) + "'",
    "echo '" + askFile(blocks) + "' > \"$ask_dir/call-1.ask.json\"",
    ...(blocks ? [] : ["echo '{\"type\":\"tool_execution_end\",\"toolCallId\":\"call-1\"}'"]),
    "while [ ! -f \"$ask_dir/call-1.reply.json\" ]; do sleep 0.2; done",
    "cp \"$ask_dir/call-1.reply.json\" \"" + bin + "/reply\"",
    ...(blocks ? ["echo '{\"type\":\"tool_execution_end\",\"toolCallId\":\"call-1\"}'"] : []),
    "echo '{\"type\":\"turn_end\"}'",
    "if grep -q '\"answer\"' \"" + bin + "/reply\"; then exit 1; fi",
    "exec sleep 60"
  ])
}

const runArgs = ["run", "task.md", "--branch", "orc/test", "--sandbox", "none"]

const askedInHistory = (fixture: NoSandboxFixture) =>
  Effect.runPromise(Effect.acquireUseRelease(
    openDatabase(fixture.env["ORC_HOME"] ?? ""),
    (db) => Effect.gen(function*() {
      const runs = yield* listRuns(db)
      return yield* openQuestionsForRun(db, runs[0]?.id ?? "")
    }),
    (db) => Effect.sync(() => db.close())
  ).pipe(Effect.provide(BunServices.layer)))

const piRuns = async (fixture: NoSandboxFixture): Promise<number> =>
  (await readFile(join(fixture.fakeBin, "pi-runs"), "utf8")).trim().split("\n").length

const liveAsking = async (fixture: NoSandboxFixture): Promise<{ readonly runDir: string; readonly asking: unknown }> => {
  const runs = join(fixture.env["ORC_HOME"] ?? "", "runs")
  for (let tries = 0; tries < 200; tries++) {
    const names = await readdir(runs).catch(() => [])
    for (const name of names) {
      const text = await readFile(join(runs, name, "asking.json"), "utf8").catch(() => null)
      if (text !== null) {
        return { runDir: join(runs, name), asking: JSON.parse(text) }
      }
    }
    await Bun.sleep(100)
  }
  throw new Error("no run wrote asking.json")
}

const askedAt = (asking: unknown): string =>
  typeof asking === "object" && asking !== null && "asked" in asking && typeof asking.asked === "string" ? asking.asked : ""

const answerLive = async (fixture: NoSandboxFixture, words: string): Promise<unknown> => {
  const { runDir, asking } = await liveAsking(fixture)
  await writeFile(join(runDir, "answers.json"), JSON.stringify({ asking: askedAt(asking), answers: [{ question: "ask-1", answer: words }] }))
  return asking
}

describe("orc run with Pi asking the captain mid-run", () => {
  test("a blocking ask with no answer in the wait stops Pi and leaves ask-1 open for the park, instead of waiting on or guessing", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await askingPi(fixture, true)
      const started = Date.now()
      const result = await runOrc(runArgs, fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "2" })
      expect(Date.now() - started).toBeLessThan(40_000)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain("orc stopped Pi when no answer to its question ask-1 came in time: Keep the old flag?")
      expect(JSON.parse(await readFile(join(fixture.fakeBin, "reply"), "utf8"))).toEqual({ kind: "timeout", id: "ask-1" })
      expect(await piRuns(fixture)).toBe(1)
      expect(await askedInHistory(fixture)).toEqual([expect.objectContaining({ id: "ask-1", text: "Keep the old flag?\nContext: Two callers still pass it.\nA) Keep the old flag\nB) Drop the old flag (picture: docs/flag.png)" })])
      const argv = await readFile(join(fixture.fakeBin, "first-argv"), "utf8")
      expect(argv).toContain("--orc-ask-dir")
      expect(argv).toContain(",orc_ask")
      const copied = await readFile(join(fixture.fakeBin, "extension-copy"), "utf8")
      const checkFile = join(fixture.fakeBin, "extension-check.ts")
      await writeFile(checkFile, copied)
      interface ExtensionTool {
        readonly name: string
        readonly execute: (id: string, params: unknown) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>
      }
      interface ExtensionHost {
        readonly registerFlag: (name: string) => void
        readonly getFlag: (name: string) => string | undefined
        readonly registerTool: (tool: ExtensionTool) => void
        readonly on: () => void
      }
      const isExtensionModule = (value: unknown): value is { readonly default: (host: ExtensionHost) => void } =>
        typeof value === "object" && value !== null && "default" in value && typeof value.default === "function"
      const loaded: unknown = await import(checkFile)
      if (!isExtensionModule(loaded)) {
        throw new Error("the copied extension registers no orc_ask tool")
      }
      const registered = new Map<string, ExtensionTool>()
      const host: ExtensionHost = {
        registerFlag: () => undefined,
        getFlag: (name) => name === "orc-ask-dir" ? fixture.fakeBin : undefined,
        registerTool: (tool) => {
          registered.set(tool.name, tool)
        },
        on: () => undefined
      }
      loaded.default(host)
      const tool = registered.get("orc_ask")
      if (tool === undefined) {
        throw new Error("the copied extension registers no orc_ask tool")
      }
      const nonBlocking = await tool.execute("call-check", {
        question: "Keep the old flag?",
        options: [{ text: "Keep the old flag", outcome: "Both callers keep working" }, { text: "Drop the old flag", outcome: "Both callers need a change" }],
        recommendation: "Keep the old flag",
        blocks: false
      })
      expect(nonBlocking.content.map((block) => block.text).join("")).toContain("Carry on")
    })
  }, 60_000)

  test("a blocking ask with no answer in the wait ends a scout run failed with the question in its reason, instead of leaving it waiting", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await askingPi(fixture, true)
      const result = await runOrc(["run", "task.md", "--kind", "scout", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "2" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain("orc stopped Pi when no answer to its question ask-1 came in time: Keep the old flag?")
      expect(JSON.parse(await readFile(join(fixture.fakeBin, "reply"), "utf8"))).toEqual({ kind: "timeout", id: "ask-1" })
    })
  }, 60_000)

  test("the answer to a parked ask resumes the same Pi session with it, instead of a fresh session without it", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await askingPi(fixture, true)
      await runOrc(runArgs, fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "2" })
      await runOrc([...runArgs, "--answer", "ask-1=B"], fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "0" })
      expect(await piRuns(fixture)).toBe(2)
      expect(await readFile(join(fixture.fakeBin, "resumed-argv"), "utf8")).toContain(sessionId)
      expect(await readFile(join(fixture.fakeBin, "resumed-prompt"), "utf8")).toContain("Owner answered your question ask-1: B")
    })
  }, 60_000)

  test("a blocking ask answered within the wait hands the answer to the waiting tool, instead of stopping Pi", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await askingPi(fixture, true)
      const running = runOrc(runArgs, fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "30" })
      const asking = await answerLive(fixture, "B")
      expect(asking).toMatchObject({ questions: [{ id: "ask-1", options }] })
      const result = await running
      expect(JSON.parse(await readFile(join(fixture.fakeBin, "reply"), "utf8"))).toEqual({ kind: "answer", id: "ask-1", question: "Keep the old flag?", words: "B" })
      expect(result.stdout).not.toContain("came in time")
      expect(await askedInHistory(fixture)).toEqual([])
    })
  }, 60_000)

  test("a non-blocking ask lets Pi go on and still gets the answer later in the run, instead of holding Pi until it comes", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await askingPi(fixture, false)
      const running = runOrc(runArgs, fixture.repo, { ...fixture.env, ORC_ANSWER_WAIT_SECONDS: "30" })
      await answerLive(fixture, "B")
      await running
      expect(JSON.parse(await readFile(join(fixture.fakeBin, "reply"), "utf8"))).toEqual({ kind: "answer", id: "ask-1", question: "Keep the old flag?", words: "B" })
    })
  }, 60_000)
})
