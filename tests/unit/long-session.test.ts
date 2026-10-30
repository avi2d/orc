import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/agents"
import { buildResumePlan } from "../../packages/run/src/run-resume"
import { readShow } from "../../packages/run/src/show"
import { openDatabase } from "../../packages/run/src/run-history"
import { runWithHistory } from "../../packages/run/src/run"
import type { HistoryRun } from "../../packages/run/src/run-record"
import type { SandboxOps } from "../../packages/run/src/run-loop"
import { subprocessNoMistakesRunner } from "../../packages/run/src/no-mistakes"
import {
  countSessionSize,
  handoverFileName,
  handoverImplementPrompt,
  handoverNote,
  lastAssistantReply,
  longSessionSignal,
  longSessionWarning
} from "../../packages/run/src/long-session"
import { anchorOf, decodeOrcShow, orcPipelineOf, orcRunOf } from "@tui-dash/schema"
import { valueOf } from "../lib/outcomes"
import { fixture } from "../lib/fixtures"

const message = (role: string, text?: string): string =>
  JSON.stringify({ type: "message", message: { role, content: text === undefined ? [] : [{ type: "text", text }] } })

const turns = (count: number): string =>
  Array.from({ length: count }, (_, index) => message(index % 2 === 0 ? "user" : "assistant", "turn " + index.toString())).join("\n") + "\n"

const compactions = (count: number): string =>
  Array.from({ length: count }, (_, index) =>
    JSON.stringify({ type: "compaction", id: "k" + index.toString(), timestamp: "2026-10-01T09:00:00.000Z", summary: "work so far" })
  ).join("\n") + "\n"

describe("countSessionSize", () => {
  test("counts the recorded long session as 13 turns and 5 compactions instead of miscounting its records", () => {
    expect(countSessionSize(fixture("long-session.jsonl"))).toEqual({ turns: 13, compactions: 5 })
  })

  test("leaves system prompts, tool results and torn lines out of the turn count instead of inflating it", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "system", content: [] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
      JSON.stringify({ type: "context_edit", id: "c1" }),
      JSON.stringify({ type: "session", id: "s1" }),
      "not json",
      "",
      "[1,2]",
      message("user", "hello")
    ].join("\n")
    expect(countSessionSize(jsonl)).toEqual({ turns: 1, compactions: 0 })
  })

  test("counts a tool-call-only assistant message as a turn instead of dropping silent work", () => {
    expect(countSessionSize(message("assistant") + "\n")).toEqual({ turns: 1, compactions: 0 })
  })
})

describe("longSessionWarning", () => {
  test("stays silent below both limits instead of warning early", () => {
    expect(longSessionWarning({ turns: 299, compactions: 4 })).toBeNull()
    expect(longSessionWarning(countSessionSize(turns(299)))).toBeNull()
    expect(longSessionWarning(countSessionSize(compactions(4)))).toBeNull()
  })

  test("warns at exactly 300 turns instead of waiting longer", () => {
    const warning = longSessionWarning(countSessionSize(turns(300)))
    expect(warning).toContain("300 turns")
    expect(warning).toContain(handoverFileName)
  })

  test("warns at exactly 5 compactions instead of waiting longer", () => {
    const warning = longSessionWarning(countSessionSize(compactions(5)))
    expect(warning).toContain("5 compactions")
    expect(warning).toContain(handoverFileName)
  })

  test("names both measures when both limits trip instead of only one", () => {
    const warning = longSessionWarning({ turns: 300, compactions: 5 })
    expect(warning).toContain("300 turns")
    expect(warning).toContain("5 compactions")
  })

  test("trips on the recorded long session through its compactions instead of missing it", () => {
    const warning = longSessionWarning(countSessionSize(fixture("long-session.jsonl")))
    expect(warning).toContain("reached 5 compactions")
    expect(warning).not.toContain("reached 300 turns")
  })
})

describe("longSessionSignal", () => {
  test("stays empty below the limits instead of flagging short sessions", () => {
    expect(longSessionSignal({ turns: 1, compactions: 0 })).toEqual([])
    expect(longSessionSignal(null)).toEqual([])
  })

  test("names the long-session signal where the token signals show instead of hiding the warning", () => {
    const signals = longSessionSignal({ turns: 13, compactions: 5 })
    expect(signals.length).toBe(1)
    expect(signals[0]?.name).toBe("long-session")
    expect(signals[0]?.value).toContain("5 compactions")
  })
})

describe("handoverNote", () => {
  test("keeps what the run did, what is left and where it stopped instead of a bare pointer", () => {
    const note = handoverNote({
      runId: "run-1",
      branch: "orc/sample",
      counts: { turns: 13, compactions: 5 },
      commits: [{ sha: "abc1234", subject: "Add the sample widget" }],
      taskText: "Implement the endpoint and document it.",
      lastReply: "Implemented the endpoint.",
      endReason: "The lint check still failed after 2 fix attempts."
    })
    expect(note).toContain("abc1234 Add the sample widget")
    expect(note).toContain("Implement the endpoint and document it.")
    expect(note).toContain("Implemented the endpoint.")
    expect(note).toContain("Compare the task text above with the commits to find what is left.")
    expect(note).toContain("Stop reason: The lint check still failed after 2 fix attempts.")
    expect(note).toContain("orc/sample")
    expect(note).toContain("run-1")
    expect(note).toContain("13 turns")
    expect(note).toContain("5 compactions")
  })

  test("says the run made no commit instead of leaving the section empty", () => {
    const note = handoverNote({
      runId: "run-2",
      branch: "orc/sample",
      counts: { turns: 300, compactions: 0 },
      commits: [],
      taskText: "Implement the endpoint and document it.",
      lastReply: null,
      endReason: "Pi stopped without printing ORC_COMPLETE."
    })
    expect(note).toContain("Made no commit.")
    expect(note).toContain("Implement the endpoint and document it.")
  })

  test("keeps only the first 2000 characters of a long last reply instead of pasting the whole reply", () => {
    const reply = "a".repeat(2000) + "b".repeat(500)
    const jsonl = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } })
    expect(lastAssistantReply(jsonl)).toBe("a".repeat(2000))
    expect(lastAssistantReply(null)).toBeNull()
  })
})

describe("handoverImplementPrompt", () => {
  const agent: AgentFile = {
    kind: "implementer",
    model: "example/sample",
    thinking: "high",
    tools: ["read"],
    body: "Do the task.",
    path: "bundled/implementer.md",
    source: "bundled"
  }

  test("starts the next run from the note instead of the bare task", () => {
    const prompt = handoverImplementPrompt(agent, "/runs/run-2/task.md", "# Handover run-1\n\nThe widget is done.")
    expect(prompt).toContain("Do the task.")
    expect(prompt).toContain("# Handover run-1\n\nThe widget is done.")
    expect(prompt).toContain("/runs/run-2/task.md")
    expect(prompt).toContain("ORC_COMPLETE")
  })
})

const implementer: AgentFile = {
  kind: "implementer",
  model: "example/sample",
  thinking: "high",
  tools: ["read"],
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
}

const fixer: AgentFile = {
  kind: "fixer",
  model: "example/sample",
  thinking: "high",
  tools: ["read"],
  body: "Fix the failure.",
  path: "bundled/fixer.md",
  source: "bundled"
}

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-long-session-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const stubGit = async (dir: string): Promise<string> => {
  const bin = join(dir, "git-bin")
  await mkdir(bin, { recursive: true })
  const git = join(bin, "git")
  await writeFile(git, ["#!/bin/sh", "exit 0"].join("\n") + "\n")
  await chmod(git, 0o755)
  return git
}

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const historyFor = (runId: string, home: string, projectDir: string, started: string, git: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runDir = path.join(home, "runs", runId)
    const run: HistoryRun = {
      fs, path, spawner, git, projectDir, runId, runDir,
      piSessionDir: path.join(runDir, "session"),
      hostSessionsDir: path.join(runDir, "sessions"),
      taskPath: path.join(runDir, "task.md"),
      agent: implementer, fixer, branch: "orc/sample", sandbox: "none", started,
      worktreeDir: projectDir,
      noMistakes: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git, worktreeDir: projectDir }),
      allow: [], answers: []
    }
    return run
  }).pipe(Effect.provide(BunServices.layer))

describe("a replayed long session", () => {
  test("raises the warning, writes the handover and starts the next run from the note instead of starting it cold", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        const run = await Effect.runPromise(historyFor("run-1", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(run.runDir, { recursive: true })
        await writeFile(run.taskPath, "Add a sample widget to the demo page.\n")
        const sessionDir = join(run.hostSessionsDir, "host")
        await mkdir(sessionDir, { recursive: true })
        await writeFile(join(sessionDir, "2026-10-01T09-00-00-000Z_sample-session-1.jsonl"), fixture("long-session.jsonl"))
        const ops: SandboxOps = {
          runAgent: async () => ({
            iterations: [{ sessionId: "sample-session-1" }],
            stdout: "",
            commits: [{ sha: "abc1234" }]
          }),
          execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        }
        const report = await Effect.runPromise(runWithHistory(db, run, ops))
        expect(report.sessionSize).toEqual({ turns: 13, compactions: 5 })
        expect(longSessionWarning(report.sessionSize ?? { turns: 0, compactions: 0 })).toContain("5 compactions")
        const handover = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* fs.readFileString(join(run.runDir, handoverFileName))
          }).pipe(Effect.provide(BunServices.layer))
        )
        expect(handover).toContain("abc1234")
        expect(handover).toContain("13 turns")
        const shown = await Effect.runPromise(readShow(db, "run-1"))
        const implement = shown?.steps.find((step) => step.name === "implement")
        expect(implement?.signals.some((signal) => signal.name === "input-tokens")).toBe(true)
        expect(implement?.signals.some((signal) => signal.name === "long-session" && signal.value.includes("5 compactions"))).toBe(true)
        expect(implement?.evidence.some((item) => item.kind === "handover")).toBe(true)
        expect(handover).toContain("Add a sample widget to the demo page.")
        expect(handover).toContain("Compare the task text above with the commits to find what is left.")
        const next = await Effect.runPromise(historyFor("run-2", home, project, "2026-10-01T10:00:00.000Z", git))
        await mkdir(next.runDir, { recursive: true })
        await writeFile(next.taskPath, "Add a sample widget to the demo page.\n")
        const plan = await Effect.runPromise(buildResumePlan(db, next))
        expect(plan.handover).toBe(handover)
        expect(plan.implementSessionId).toBeNull()
        expect(plan.implementSessionFile).toBeNull()
        const prompts: Array<string> = []
        const resumed: Array<string | undefined> = []
        const nextOps: SandboxOps = {
          runAgent: async (_agent, prompt, _log, resumeSession) => {
            prompts.push(prompt)
            resumed.push(resumeSession)
            return { iterations: [], stdout: "", commits: [] }
          },
          execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        }
        await Effect.runPromise(runWithHistory(db, next, nextOps))
        expect(prompts.length).toBe(1)
        expect(prompts[0]).toContain(handover)
        expect(prompts[0]).toContain("task.md")
        expect(resumed).toEqual([undefined])
      } finally {
        db.close()
      }
    })
  })
})


describe("a long session carries its warning to the run", () => {
  test("shows the long-session warning on the failed checks anchor instead of hiding it with the passed agent stage", () => {
    const warning = longSessionWarning({ turns: 13, compactions: 5 }) ?? ""
    const snapshot = valueOf(decodeOrcShow(JSON.stringify({
      schema: "orc.show.v1",
      run: { id: "run-1", branch: "orc/sample" },
      steps: [
        { name: "implement", status: "passed", score: null, signals: [{ name: "long-session", value: warning }] },
        { name: "checks", status: "failed", score: null }
      ]
    })))
    const run = orcRunOf(snapshot, "run-1", [])
    expect(run?.notice).toBe(warning)
    expect(run?.stages.find((stage) => stage.name === "implement")?.detail).toBeUndefined()
    const pipeline = orcPipelineOf(run, "working")
    expect(anchorOf(pipeline.stages)?.name).toBe("checks")
    expect(anchorOf(pipeline.stages)?.detail).toContain("5 compactions")
  })
})

describe("a long session survives a later failure", () => {
  test("lists the implementation and fixer commits when the next check fails to spawn instead of keeping only the checkpoint list", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        await writeFile(join(project, ".no-mistakes.yaml"), "commands:\n  test: bun test\n")
        const git = await stubGit(home)
        const run = await Effect.runPromise(historyFor("run-9", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(run.runDir, { recursive: true })
        await writeFile(run.taskPath, "Add a sample widget to the demo page.\n")
        const finalText = "work done\nORC_COMPLETE"
        const sessionJsonl = compactions(5) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: finalText }] } }) + "\n"
        const sessionDir = join(run.hostSessionsDir, "host")
        await mkdir(sessionDir, { recursive: true })
        await writeFile(join(sessionDir, "2026-10-01T09-00-00-000Z_long-ok.jsonl"), sessionJsonl)
        let agentCalls = 0
        let checkCalls = 0
        let checkpointSeen = false
        const ops: SandboxOps = {
          runAgent: async () => {
            agentCalls += 1
            if (agentCalls === 1) {
              return {
                iterations: [{ sessionId: "long-ok" }],
                stdout: "",
                completionSignal: "ORC_COMPLETE",
                commits: [{ sha: "abc1234" }]
              }
            }
            return { iterations: [], stdout: "", commits: [{ sha: "def5678" }] }
          },
          execCheck: async () => {
            checkCalls += 1
            if (checkCalls === 1) {
              return { stdout: "", stderr: "failing", exitCode: 1 }
            }
            try {
              await readFile(join(run.runDir, handoverFileName), "utf8")
              checkpointSeen = true
            } catch {
              checkpointSeen = false
            }
            throw new Error("spawn bun ENOENT")
          }
        }
        const report = await Effect.runPromise(runWithHistory(db, run, ops))
        expect(checkCalls).toBe(2)
        expect(agentCalls).toBe(2)
        expect(checkpointSeen).toBe(true)
        expect(report.sessionSize).toEqual({ turns: 1, compactions: 5 })
        const handover = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* fs.readFileString(join(run.runDir, handoverFileName))
          }).pipe(Effect.provide(BunServices.layer))
        )
        expect(handover).toContain("abc1234")
        expect(handover).toContain("def5678")
        expect(handover).toContain("Add a sample widget to the demo page.")
        expect(handover).toContain("work done")
        expect(handover).toContain("spawn bun ENOENT")
      } finally {
        db.close()
      }
    })
  })
})
