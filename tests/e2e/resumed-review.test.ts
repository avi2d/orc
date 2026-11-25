import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { reviewAtHead } from "../../packages/run/src/features/running-a-task/review-turn"
import type { SandboxOps } from "../../packages/run/src/features/running-a-task/run-ops"
import { OrcRunError } from "../../packages/run/src/shared/lib/index"

const reviewer: AgentFile = {
  kind: "reviewer", model: "acme/coder", thinking: "high", tools: ["read"],
  body: "Review the change.", path: "reviewer.md", source: "bundled"
}

const finding = { id: "unchecked-input", file: "a", line: 1, severity: "minor" as const, action: "Validate the input.", description: "The input crosses a trust boundary." }

const git = (dir: string, ...args: Array<string>): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

type Change = "unchanged" | "commit" | "missing" | "failed" | "legacy-failed" | "checkpoint-write" | "reused-checkpoint-write" | "review-write" | "reused-review-write"

const scenario = async (change: Change) => {
  const root = await mkdtemp(join(tmpdir(), "orc-resumed-review-"))
  try {
    const project = join(root, "project")
    const first = join(root, "first")
    const second = join(root, "second")
    const third = join(root, "third")
    await Promise.all([project, first, second, third].map((dir) => mkdir(join(dir, "session"), { recursive: true })))
    git(project, "init", "-q")
    await writeFile(join(project, "a"), "base")
    git(project, "add", "a")
    git(project, "commit", "-qm", "base")
    git(project, "checkout", "-qb", "orc/test")
    await writeFile(join(project, "a"), "change")
    git(project, "commit", "-qam", "work")
    git(project, "checkout", "-q", "-")
    if (change === "checkpoint-write") await mkdir(join(first, "review-checkpoint.json"))
    if (change === "reused-checkpoint-write") await mkdir(join(second, "review-checkpoint.json"))
    if (change === "review-write") await mkdir(join(first, "review.json"))
    if (change === "reused-review-write") await mkdir(join(second, "review.json"))
    let turns = 0
    const agent: SandboxOps["runAgent"] = () => Effect.gen(function*() {
      turns += 1
      if (turns === 1 && (change === "failed" || change === "legacy-failed")) {
        return yield* new OrcRunError({ message: "the reviewer could not start" })
      }
      const sessionFile = join(root, "answer-" + turns.toString() + ".jsonl")
      yield* Effect.promise(() => writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify([finding]) }], stopReason: "stop" } }) + "\n"))
      return { sessionId: null, sessionFile, end: { kind: "exited", exitCode: 0 }, commits: [] }
    })
    return await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = { fs, path, spawner, git: "git", projectDir: project, worktreeDir: project, branch: "orc/test", runDir: first, piSessionDir: join(first, "session") }
      const checkpoint = (dir: string) => fs.readFileString(join(dir, "review-checkpoint.json")).pipe(Effect.orElseSucceed(() => null))
      const original = change === "missing" ? null : yield* reviewAtHead(run, agent, reviewer, null)
      const originalCheckpoint = yield* checkpoint(first)
      const before = turns
      if (change === "commit") {
        git(project, "checkout", "-q", "orc/test")
        yield* Effect.promise(() => writeFile(join(project, "a"), "new commit"))
        git(project, "commit", "-qam", "new")
        git(project, "checkout", "-q", "-")
      }
      if (change === "legacy-failed") {
        yield* fs.writeFileString(join(first, "review-checkpoint.json"), JSON.stringify({
          head: git(project, "rev-parse", "orc/test"),
          outcome: { status: "failed", reason: "the reviewer could not start" }
        }))
      }
      const resumed = yield* reviewAtHead({ ...run, runDir: second, piSessionDir: join(second, "session") }, agent, reviewer, first)
      const resumedTurns = turns - before
      const resumedCheckpoint = yield* checkpoint(second)
      const resumedSaved = yield* fs.readFileString(join(second, "review.json")).pipe(Effect.orElseSucceed(() => null))
      const carried = change !== "unchanged" ? null : yield* Effect.gen(function*() {
        yield* fs.remove(first, { recursive: true })
        const outcome = yield* reviewAtHead({ ...run, runDir: third, piSessionDir: join(third, "session") }, agent, reviewer, second)
        const saved = yield* fs.readFileString(join(third, "review.json"))
        return { outcome, saved, turns: turns - before }
      })
      return { original, originalCheckpoint, resumed, resumedTurns, resumedCheckpoint, resumedSaved, second, third, carried }
    }).pipe(Effect.provide(BunServices.layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("direct-PR review across resume", () => {
  test("an unchanged branch keeps findings in each run folder without rerunning or depending on the first folder", async () => {
    const result = await scenario("unchanged")
    expect(result.resumedTurns).toBe(0)
    expect(result.original?.reusedFrom).toBeNull()
    expect(result.resumed).toEqual({ status: "passed", findings: [finding], file: join(result.second, "review.json"), reusedFrom: "first" })
    expect(JSON.parse(result.resumedSaved ?? "null")).toEqual([finding])
    expect(JSON.parse(result.resumedCheckpoint ?? "null")).toMatchObject({ outcome: { status: "passed", findings: [finding], file: join(result.second, "review.json") } })
    expect(result.carried?.turns).toBe(0)
    expect(result.carried?.outcome).toEqual({ status: "passed", findings: [finding], file: join(result.third, "review.json"), reusedFrom: "second" })
    expect(JSON.parse(result.carried?.saved ?? "null")).toEqual([finding])
  })

  test("a new commit does not reuse the earlier review", async () => {
    const result = await scenario("commit")
    expect(result.resumed.reusedFrom).toBeNull()
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("a missing review record does not skip the review", async () => {
    const result = await scenario("missing")
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("a failed reviewer is not checkpointed or reused on an unchanged branch", async () => {
    const result = await scenario("failed")
    expect(result.original).toEqual({ status: "failed", reason: "the reviewer could not start", reusedFrom: null })
    expect(result.originalCheckpoint).toBeNull()
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("an older failed checkpoint does not suppress a new review", async () => {
    const result = await scenario("legacy-failed")
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("a fresh checkpoint write failure does not abort the review result", async () => {
    const result = await scenario("checkpoint-write")
    expect(result.original?.status).toBe("passed")
    expect(result.originalCheckpoint).toBeNull()
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("a reused checkpoint write failure does not abort the review result", async () => {
    const result = await scenario("reused-checkpoint-write")
    expect(result.resumedTurns).toBe(0)
    expect(result.resumed).toEqual({ status: "passed", findings: [finding], file: join(result.second, "review.json"), reusedFrom: "first" })
    expect(JSON.parse(result.resumedSaved ?? "null")).toEqual([finding])
    expect(result.resumedCheckpoint).toBeNull()
  })

  test("a failed findings write is not checkpointed as a completed review", async () => {
    const result = await scenario("review-write")
    expect(result.original?.status).toBe("failed")
    expect(result.originalCheckpoint).toBeNull()
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("a reused findings write failure returns a failure instead of a stale file path or an exception", async () => {
    const result = await scenario("reused-review-write")
    expect(result.resumed.reusedFrom).toBe("first")
    expect(result.resumedTurns).toBe(0)
    expect(result.resumed.status).toBe("failed")
    expect(result.resumed).not.toHaveProperty("file")
    expect(result.resumedCheckpoint).toBeNull()
  })
})
