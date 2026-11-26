import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Effect, Exit } from "effect"
import { recordRun } from "../../packages/run/src/entities/run-history/index"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"
import { runFull } from "../../packages/run/src/features/running-a-task/run-loop"
import { fakeOps } from "../lib/fake-ops"
import { historyFor, openDb, runLoopCheckpoints, stubGit, withHome } from "../lib/run-loop-helpers"

const freshPlan = { implementSessionId: null, implementSessionFile: null, inheritedImplement: null, skipImplement: false, skipChecks: false, allow: [], answers: [], inheritedRounds: [], inheritedFixes: [], fixSessionId: null, fixSessionFile: null, fixRunning: false, handover: null, priorDir: null }

const withLoopRun = async (answerWaitSeconds: number, use: (db: Database, run: HistoryRun) => Promise<void>): Promise<void> => {
  await withHome(async (home) => {
    const db = await openDb(home)
    try {
      const project = join(home, "project")
      await mkdir(project, { recursive: true })
      const git = await stubGit(home)
      const base = await Effect.runPromise(historyFor("loop-1", home, project, "2026-10-19T10:00:00.000Z", git, ""))
      const run: HistoryRun = { ...base, answerWaitSeconds }
      await mkdir(run.runDir, { recursive: true })
      await Effect.runPromise(recordRun(db, { id: run.runId, project, branch: run.branch, taskFile: run.taskPath, status: "running", started: run.started }).pipe(Effect.asVoid))
      await use(db, run)
    } finally {
      db.close()
    }
  })
}

describe("a rebase-first run", () => {
  test("a stale local branch never replaces the observed PR head", async () => {
    await withLoopRun(0, async (db, normal) => {
      const calls = join(normal.runDir, "git-calls")
      await writeFile(normal.taskPath, "Do the task.\n")
      await writeFile(normal.git, [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> " + calls,
        "case \"$1\" in",
        "  branch) echo orc/test ;;",
        "  rev-parse) echo " + "b".repeat(40) + " ;;",
        "  symbolic-ref) echo refs/remotes/origin/main ;;",
        "  config) exit 1 ;;",
        "esac"
      ].join("\n") + "\n")
      const reply = { stdout: "", stderr: "", exitCode: 0 }
      const opener = { fetch: Effect.succeed(reply), push: Effect.succeed(reply), existing: Effect.succeed(reply), create: () => Effect.succeed(reply) }
      const run = { ...normal, delivery: { kind: "orc" as const, opener, reviewer: { ...normal.agent, kind: "reviewer" as const } }, rebase: { head: "a".repeat(40), pr: "https://github.com/example/orc/pull/7" } }
      const ops = fakeOps({ runAgent: async () => ({ commits: [] }), execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }, run.hostSessionsDir)
      const exit = await Effect.runPromiseExit(runFull(run, ops, freshPlan, runLoopCheckpoints(db, run)))
      expect(Exit.isFailure(exit)).toBe(true)
      const commands = await readFile(calls, "utf8")
      expect(commands.split("\n").some((line) => line.startsWith("push "))).toBe(false)
    })
  })
  test("a successful rebase pushes the observed head without running the implement agent", async () => {
    await withLoopRun(0, async (db, normal) => {
      const calls = join(normal.runDir, "git-calls")
      await writeFile(normal.taskPath, "Do the task.\n")
      await writeFile(normal.git, [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> " + calls,
        "case \"$1\" in",
        "  branch) echo orc/test ;;",
        "  rev-parse) echo " + "a".repeat(40) + " ;;",
        "  symbolic-ref) echo refs/remotes/origin/main ;;",
        "  config) exit 1 ;;",
        "esac"
      ].join("\n") + "\n")
      const reply = { stdout: "", stderr: "", exitCode: 0 }
      const opener = { fetch: Effect.succeed(reply), push: Effect.succeed(reply), existing: Effect.succeed(reply), create: () => Effect.succeed(reply) }
      const run = { ...normal, delivery: { kind: "orc" as const, opener, reviewer: { ...normal.agent, kind: "reviewer" as const } }, rebase: { head: "a".repeat(40), pr: "https://github.com/example/orc/pull/7" } }
      let agents = 0
      const ops = fakeOps({
        runAgent: async () => { agents += 1; return { commits: [] } },
        execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      }, run.hostSessionsDir)
      const report = await Effect.runPromise(runFull(run, ops, freshPlan, runLoopCheckpoints(db, run)))
      expect(agents).toBe(0)
      expect(report.completed).toBe(true)
      expect(report.prLink).toBe(run.rebase.pr)
      const commands = await readFile(calls, "utf8")
      expect(commands).toContain("push --force-with-lease=refs/heads/orc/test:" + "a".repeat(40))
    })
  })

  test("a moved PR head rejects the leased push without calling the implement agent", async () => {
    await withLoopRun(0, async (db, normal) => {
      const calls = join(normal.runDir, "git-calls")
      await writeFile(normal.taskPath, "Do the task.\n")
      await writeFile(normal.git, [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> " + calls,
        "case \"$1\" in",
        "  branch) echo orc/test ;;",
        "  rev-parse) echo " + "a".repeat(40) + " ;;",
        "  symbolic-ref) echo refs/remotes/origin/main ;;",
        "  config) exit 1 ;;",
        "  push) echo 'stale info' >&2; exit 1 ;;",
        "esac"
      ].join("\n") + "\n")
      const reply = { stdout: "", stderr: "", exitCode: 0 }
      const opener = { fetch: Effect.succeed(reply), push: Effect.succeed(reply), existing: Effect.succeed(reply), create: () => Effect.succeed(reply) }
      const run = { ...normal, delivery: { kind: "orc" as const, opener, reviewer: { ...normal.agent, kind: "reviewer" as const } }, rebase: { head: "a".repeat(40), pr: "https://github.com/example/orc/pull/7" } }
      let agents = 0
      const ops = fakeOps({
        runAgent: async () => { agents += 1; return { commits: [] } },
        execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      }, run.hostSessionsDir)
      const exit = await Effect.runPromiseExit(runFull(run, ops, freshPlan, runLoopCheckpoints(db, run)))
      expect(agents).toBe(0)
      expect(Exit.isFailure(exit)).toBe(true)
      const commands = await readFile(calls, "utf8")
      expect(commands).toContain("push --force-with-lease=refs/heads/orc/test:" + "a".repeat(40))
      expect(commands.split("\n").filter((line) => line.startsWith("push "))).toHaveLength(1)
    })
  })
})
