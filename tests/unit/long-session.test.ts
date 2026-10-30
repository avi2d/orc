import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
  inheritedHandoverFileName,
  lastAssistantReply,
  longSessionSignal,
  longSessionWarning
} from "../../packages/run/src/long-session"
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

const branchLogGit = async (dir: string, logFile: string): Promise<string> => {
  const bin = join(dir, "git-bin")
  await mkdir(bin, { recursive: true })
  const git = join(bin, "git")
  await writeFile(git, ["#!/bin/sh", "if [ \"$1\" = \"log\" ]; then", "  cat \"" + logFile + "\" 2>/dev/null || true", "fi", "exit 0"].join("\n") + "\n")
  await chmod(git, 0o755)
  return git
}

const readHandover = (runDir: string, file: string = handoverFileName): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFileString(join(runDir, file))
    }).pipe(Effect.provide(BunServices.layer))
  )

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


describe("an inherited handover survives a failed restart", () => {
  test("forwards the loaded note so the run after a failed start still resumes from it instead of the bare task", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const logFile = join(home, "branch-log.txt")
        await writeFile(logFile, "abc1234\x1fImplement A\n")
        const git = await branchLogGit(home, logFile)
        const taskText = "Add a sample widget to the demo page.\n"
        const runA = await Effect.runPromise(historyFor("run-a", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(runA.runDir, { recursive: true })
        await writeFile(runA.taskPath, taskText)
        const sessionDirA = join(runA.hostSessionsDir, "host")
        await mkdir(sessionDirA, { recursive: true })
        await writeFile(join(sessionDirA, "2026-10-01T09-00-00-000Z_long-a.jsonl"), compactions(5) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work in progress" }] } }) + "\n")
        const reportA = await Effect.runPromise(runWithHistory(db, runA, {
          runAgent: async () => ({ iterations: [{ sessionId: "long-a" }], stdout: "", commits: [{ sha: "abc1234" }] }),
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }))
        expect(reportA.completed).toBe(false)
        expect(reportA.sessionSize).toEqual({ turns: 1, compactions: 5 })
        const handoverA = await readHandover(runA.runDir)
        expect(handoverA).toContain("abc1234")
        const runB = await Effect.runPromise(historyFor("run-b", home, project, "2026-10-01T10:00:00.000Z", git))
        await mkdir(runB.runDir, { recursive: true })
        await writeFile(runB.taskPath, taskText)
        const reportB = await Effect.runPromise(runWithHistory(db, runB, {
          runAgent: async () => { throw new Error("pi exploded") },
          execCheck: async () => { throw new Error("checks must not run when the agent never starts") }
        }))
        expect(reportB.completed).toBe(false)
        const forwarded = await readHandover(runB.runDir, inheritedHandoverFileName)
        expect(forwarded).toBe(handoverA)
        const runC = await Effect.runPromise(historyFor("run-c", home, project, "2026-10-01T11:00:00.000Z", git))
        await mkdir(runC.runDir, { recursive: true })
        await writeFile(runC.taskPath, taskText)
        const planC = await Effect.runPromise(buildResumePlan(db, runC))
        expect(planC.handover).toBe(forwarded)
        expect(planC.implementSessionId).toBeNull()
        const prompts: Array<string> = []
        const resumed: Array<string | undefined> = []
        const reportC = await Effect.runPromise(runWithHistory(db, runC, {
          runAgent: async (_agent, prompt, _log, resumeSession) => {
            prompts.push(prompt)
            resumed.push(resumeSession)
            return { iterations: [], stdout: "", commits: [] }
          },
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }))
        expect(prompts.length).toBe(1)
        expect(prompts[0]).toContain("abc1234")
        expect(resumed).toEqual([undefined])
        expect(reportC.commits?.some((commit) => commit.sha === "abc1234")).toBe(true)
      } finally {
        db.close()
      }
    })
  })

  test("fails the run instead of dropping the note when forwarding hits a storage error", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const logFile = join(home, "branch-log.txt")
        await writeFile(logFile, "abc1234\x1fImplement A\n")
        const git = await branchLogGit(home, logFile)
        const taskText = "Add a sample widget to the demo page.\n"
        const runA = await Effect.runPromise(historyFor("run-a", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(runA.runDir, { recursive: true })
        await writeFile(runA.taskPath, taskText)
        const sessionDirA = join(runA.hostSessionsDir, "host")
        await mkdir(sessionDirA, { recursive: true })
        await writeFile(join(sessionDirA, "2026-10-01T09-00-00-000Z_long-a.jsonl"), compactions(5) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work in progress" }] } }) + "\n")
        await Effect.runPromise(runWithHistory(db, runA, {
          runAgent: async () => ({ iterations: [{ sessionId: "long-a" }], stdout: "", commits: [{ sha: "abc1234" }] }),
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }))
        const handoverA = await readHandover(runA.runDir)
        const runB = await Effect.runPromise(historyFor("run-b", home, project, "2026-10-01T10:00:00.000Z", git))
        await mkdir(join(home, "runs"), { recursive: true })
        await writeFile(runB.runDir, "not a directory\n")
        const failure = await Effect.runPromise(Effect.flip(runWithHistory(db, runB, {
          runAgent: async () => { throw new Error("the agent must not start when forwarding fails") },
          execCheck: async () => { throw new Error("checks must not run when forwarding fails") }
        })))
        expect(failure.message).toContain("handover")
        const runC = await Effect.runPromise(historyFor("run-c", home, project, "2026-10-01T11:00:00.000Z", git))
        await mkdir(runC.runDir, { recursive: true })
        await writeFile(runC.taskPath, taskText)
        const planC = await Effect.runPromise(buildResumePlan(db, runC))
        expect(planC.handover).toBe(handoverA)
      } finally {
        db.close()
      }
    })
  })

  test("resumes the interrupted implement session instead of restarting from the inherited note", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const logFile = join(home, "branch-log.txt")
        await writeFile(logFile, "abc1234\x1fImplement A\n")
        const git = await branchLogGit(home, logFile)
        const taskText = "Add a sample widget to the demo page.\n"
        const runA = await Effect.runPromise(historyFor("run-a", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(runA.runDir, { recursive: true })
        await writeFile(runA.taskPath, taskText)
        const sessionDirA = join(runA.hostSessionsDir, "host")
        await mkdir(sessionDirA, { recursive: true })
        await writeFile(join(sessionDirA, "2026-10-01T09-00-00-000Z_long-a.jsonl"), compactions(5) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work in progress" }] } }) + "\n")
        await Effect.runPromise(runWithHistory(db, runA, {
          runAgent: async () => ({ iterations: [{ sessionId: "long-a" }], stdout: "", commits: [{ sha: "abc1234" }] }),
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }))
        const handoverA = await readHandover(runA.runDir)
        const runB = await Effect.runPromise(historyFor("run-b", home, project, "2026-10-01T10:00:00.000Z", git))
        await mkdir(runB.runDir, { recursive: true })
        await writeFile(runB.taskPath, taskText)
        const reportB = await Effect.runPromise(runWithHistory(db, runB, {
          runAgent: async () => {
            const liveDir = join(runB.hostSessionsDir, "host")
            await mkdir(liveDir, { recursive: true })
            await writeFile(join(liveDir, "2026-10-01T10-00-00-000Z_live-b.jsonl"), message("assistant", "halfway there") + "\n")
            throw new Error("killed mid-implement")
          },
          execCheck: async () => { throw new Error("checks must not run when implement never finishes") }
        }))
        expect(reportB.completed).toBe(false)
        expect(await readHandover(runB.runDir, inheritedHandoverFileName)).toBe(handoverA)
        const runC = await Effect.runPromise(historyFor("run-c", home, project, "2026-10-01T11:00:00.000Z", git))
        await mkdir(runC.runDir, { recursive: true })
        await writeFile(runC.taskPath, taskText)
        const planC = await Effect.runPromise(buildResumePlan(db, runC))
        expect(planC.handover).toBe(handoverA)
        expect(planC.implementSessionId).toBe("live-b")
        const prompts: Array<string> = []
        const resumed: Array<string | undefined> = []
        const reportC = await Effect.runPromise(runWithHistory(db, runC, {
          runAgent: async (_agent, prompt, _log, resumeSession) => {
            prompts.push(prompt)
            resumed.push(resumeSession)
            return { iterations: [{ sessionId: "live-b" }], stdout: "", commits: [] }
          },
          execCheck: async () => { throw new Error("checks must not run for an unverified implement") }
        }))
        expect(prompts.length).toBe(1)
        expect(prompts[0]).toContain("abc1234")
        expect(resumed).toEqual(["live-b"])
        expect(reportC.commits?.some((commit) => commit.sha === "abc1234")).toBe(true)
      } finally {
        db.close()
      }
    })
  })
})

