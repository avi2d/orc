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

const reviewer: AgentFile = {
  kind: "reviewer", model: "acme/coder", thinking: "high", tools: ["read"],
  body: "Review the change.", path: "reviewer.md", source: "bundled"
}

const git = (dir: string, ...args: Array<string>): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const scenario = async (change: "unchanged" | "commit" | "missing") => {
  const root = await mkdtemp(join(tmpdir(), "orc-resumed-review-"))
  try {
    const project = join(root, "project")
    const first = join(root, "first")
    const second = join(root, "second")
    await Promise.all([project, first, second].map((dir) => mkdir(join(dir, "session"), { recursive: true })))
    git(project, "init", "-q")
    await writeFile(join(project, "a"), "base")
    git(project, "add", "a")
    git(project, "commit", "-qm", "base")
    git(project, "checkout", "-qb", "orc/test")
    await writeFile(join(project, "a"), "change")
    git(project, "commit", "-qam", "work")
    git(project, "checkout", "-q", "-")
    let turns = 0
    const agent: SandboxOps["runAgent"] = () => Effect.promise(async () => {
      turns += 1
      const sessionFile = join(root, "answer-" + turns.toString() + ".jsonl")
      await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "[]" }], stopReason: "stop" } }) + "\n")
      return { sessionId: null, sessionFile, end: { kind: "exited", exitCode: 0 }, commits: [] }
    })
    return await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = { fs, path, spawner, git: "git", projectDir: project, worktreeDir: project, branch: "orc/test", runDir: first, piSessionDir: join(first, "session") }
      const original = change === "missing" ? null : yield* reviewAtHead(run, agent, reviewer, null)
      const before = turns
      if (change === "commit") {
        git(project, "checkout", "-q", "orc/test")
        yield* Effect.promise(() => writeFile(join(project, "a"), "new commit"))
        git(project, "commit", "-qam", "new")
        git(project, "checkout", "-q", "-")
      }
      const resumed = yield* reviewAtHead({ ...run, runDir: second, piSessionDir: join(second, "session") }, agent, reviewer, first)
      return { original, resumed, resumedTurns: turns - before }
    }).pipe(Effect.provide(BunServices.layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("direct-PR review across resume", () => {
  test("an unchanged branch does not run the review again or lose its result", async () => {
    const result = await scenario("unchanged")
    expect(result.resumedTurns).toBe(0)
    expect(result.resumed).toEqual(result.original)
    expect(result.resumed.status).toBe("passed")
  })

  test("a new commit does not reuse the earlier review", async () => {
    const result = await scenario("commit")
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })

  test("a missing review record does not skip the review", async () => {
    const result = await scenario("missing")
    expect(result.resumedTurns).toBe(1)
    expect(result.resumed.status).toBe("passed")
  })
})
