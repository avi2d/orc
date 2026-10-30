import { describe, expect, test } from "bun:test"
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { DateTime, Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/agents"
import { buildResumePlan } from "../../packages/run/src/run-resume"
import { readShow } from "../../packages/run/src/show"
import { openDatabase } from "../../packages/run/src/run-history"
import { runWithHistory } from "../../packages/run/src/run"
import type { HistoryRun } from "../../packages/run/src/run-record"
import type { SandboxOps } from "../../packages/run/src/run-loop"
import { subprocessNoMistakesRunner, type NoMistakesRunner } from "../../packages/run/src/no-mistakes"
import { drawTasks, type TasksReadings } from "@tui-dash/tasks"
import { plain } from "@tui-dash/ui"
import { handoverFileName, longSessionWarning } from "../../packages/run/src/long-session"
import { anchorOf, decodeOrcShow, ok, orcPipelineOf, orcRunOf, taskLevels } from "@tui-dash/schema"
import { pipelineTaskReadings } from "../lib/task-levels-fixture"
import { valueOf } from "../lib/outcomes"

const compactions = (count: number): string =>
  Array.from({ length: count }, (_, index) =>
    JSON.stringify({ type: "compaction", id: "k" + index.toString(), timestamp: "2026-10-01T09:00:00.000Z", summary: "work so far" })
  ).join("\n") + "\n"

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

describe("a handover after a passed implement", () => {
  test("resumes the passed implement session instead of starting fresh when the handover follows a passed implement", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        await writeFile(join(project, ".no-mistakes.yaml"), "commands:\n  test: bun test\n")
        const logFile = join(home, "branch-log.txt")
        await writeFile(logFile, "")
        const git = await branchLogGit(home, logFile)
        const taskText = "Add a sample widget to the demo page.\n"
        const runA = await Effect.runPromise(historyFor("run-a", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(runA.runDir, { recursive: true })
        await writeFile(runA.taskPath, taskText)
        const sessionDirA = join(runA.hostSessionsDir, "host")
        await mkdir(sessionDirA, { recursive: true })
        await writeFile(join(sessionDirA, "2026-10-01T09-00-00-000Z_long-pass.jsonl"), compactions(5) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work done\nORC_COMPLETE" }] } }) + "\n")
        let agentCalls = 0
        let checkCalls = 0
        await Effect.runPromise(runWithHistory(db, runA, {
          runAgent: async () => {
            agentCalls += 1
            if (agentCalls === 1) {
              await appendFile(logFile, "abc1234\x1fImplement A\n")
              return {
                iterations: [{ sessionId: "long-pass" }],
                stdout: "",
                completionSignal: "ORC_COMPLETE",
                commits: [{ sha: "abc1234" }]
              }
            }
            await appendFile(logFile, "def5678\x1fFix B\n")
            return { iterations: [], stdout: "", commits: [{ sha: "def5678" }] }
          },
          execCheck: async () => {
            checkCalls += 1
            if (checkCalls === 1) {
              return { stdout: "", stderr: "failing", exitCode: 1 }
            }
            throw new Error("spawn bun ENOENT")
          }
        }))
        expect(checkCalls).toBe(2)
        const handoverA = await readHandover(runA.runDir)
        expect(handoverA).toContain("abc1234")
        const runB = await Effect.runPromise(historyFor("run-b", home, project, "2026-10-01T10:00:00.000Z", git))
        await mkdir(runB.runDir, { recursive: true })
        await writeFile(runB.taskPath, taskText)
        const planB = await Effect.runPromise(buildResumePlan(db, runB))
        expect(planB.handover).toBe(handoverA)
        expect(planB.skipImplement).toBe(true)
        expect(planB.implementSessionId).toBe("long-pass")
        expect(planB.implementSessionFile).toContain("long-pass")
      } finally {
        db.close()
      }
    })
  })
})

describe("a handover written after no-mistakes", () => {
  test("lists a commit that landed during no-mistakes instead of only the checkpoint and loop commits", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        await writeFile(join(project, ".no-mistakes.yaml"), "commands:\n  test: bun test\n")
        const logFile = join(home, "branch-log.txt")
        await writeFile(logFile, "abc1234\x1fImplement A\n")
        const git = await branchLogGit(home, logFile)
        const run = await Effect.runPromise(historyFor("run-nm", home, project, "2026-10-01T09:00:00.000Z", git))
        await mkdir(run.runDir, { recursive: true })
        await writeFile(run.taskPath, "Add a sample widget to the demo page.\n")
        const finalText = "work done\nORC_COMPLETE"
        const sessionJsonl = compactions(5) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: finalText }] } }) + "\n"
        const sessionDir = join(run.hostSessionsDir, "host")
        await mkdir(sessionDir, { recursive: true })
        await writeFile(join(sessionDir, "2026-10-01T09-00-00-000Z_long-nm.jsonl"), sessionJsonl)
        const fixedAfterLoop: NoMistakesRunner = {
          start: () => Effect.promise(() =>
            appendFile(logFile, "def5678\x1fFix B\n").then(() => ({
              stdout: "outcome: passed\npr: https://example.com/pr/1\n",
              stderr: "",
              exitCode: 0
            }))
          ),
          reattach: Effect.die("no reattach in this test"),
          respond: () => Effect.die("no gate in this test"),
          answer: () => Effect.die("no question in this test"),
          status: () => Effect.die("no status check in this test"),
          logs: () => Effect.die("no logs in this test")
        }
        const report = await Effect.runPromise(runWithHistory(db, { ...run, noMistakes: fixedAfterLoop }, {
          runAgent: async () => ({
            iterations: [{ sessionId: "long-nm" }],
            stdout: "",
            completionSignal: "ORC_COMPLETE",
            commits: [{ sha: "abc1234" }]
          }),
          execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        }))
        expect(report.completed).toBe(true)
        expect(report.commits?.some((commit) => commit.sha === "abc1234")).toBe(true)
        expect(report.commits?.some((commit) => commit.sha === "def5678")).toBe(false)
        const handover = await readHandover(run.runDir)
        expect(handover).toContain("abc1234")
        expect(handover).toContain("def5678")
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

  test("shows the warning and the failed checks status on the dashboard frame instead of only carrying it in the mapping", () => {
    const warning = longSessionWarning({ turns: 13, compactions: 5 }) ?? ""
    const snapshot = valueOf(decodeOrcShow(JSON.stringify({
      schema: "orc.show.v1",
      run: { id: "orc-step-7", branch: "fm/orc-step-7" },
      steps: [
        { name: "implement", status: "passed", score: null, signals: [{ name: "long-session", value: warning }] },
        { name: "checks", status: "failed", score: null }
      ]
    })))
    const readings: TasksReadings = {
      levels: taskLevels(pipelineTaskReadings({ orc: ok(snapshot) })),
      zone: DateTime.zoneMakeNamedUnsafe("UTC")
    }
    const text = drawTasks(readings, { focus: "task", project: "harbor", task: "north orc-step-7", detail: 0 }, 120, 40)
      .block.map((line) => plain(line).trimEnd()).join("\n")
    expect(text).toContain("5 compactions")
    expect(text).toContain("[✕ checks]")
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
        const logFile = join(home, "branch-log.txt")
        await writeFile(logFile, "")
        const git = await branchLogGit(home, logFile)
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
              await appendFile(logFile, "abc1234\x1fImplement A\n")
              return {
                iterations: [{ sessionId: "long-ok" }],
                stdout: "",
                completionSignal: "ORC_COMPLETE",
                commits: [{ sha: "abc1234" }]
              }
            }
            await appendFile(logFile, "def5678\x1fFix B\n")
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
        const shown = await Effect.runPromise(readShow(db, "run-9"))
        const implement = shown?.steps.find((step) => step.name === "implement")
        expect(implement?.evidence.filter((item) => item.kind === "handover").length).toBe(1)
      } finally {
        db.close()
      }
    })
  })
})
