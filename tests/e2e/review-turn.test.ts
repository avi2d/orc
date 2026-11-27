import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { reviewSentence, runReviewTurn } from "../../packages/run/src/features/running-a-task/review-turn"
import type { ReviewOutcome } from "../../packages/run/src/features/running-a-task/review-outcome"
import type { AgentRun, SandboxOps } from "../../packages/run/src/features/running-a-task/run-ops"

const reviewer: AgentFile = {
  kind: "reviewer",
  model: "acme/coder",
  thinking: "high",
  tools: ["read", "bash"],
  body: "Review the change.",
  path: "bundled/reviewer.md",
  source: "bundled"
}

const finding = { id: "stray-comment", file: "src/a.ts", line: 3, severity: "minor" as const, action: "Cut the comment.", description: "The comment restates the code." }

const gitBin = Bun.which("git") ?? "git"

const gitFixture = async (dir: string, args: ReadonlyArray<string>): Promise<void> => {
  const done = Bun.spawnSync([gitBin, ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "orc test", GIT_AUTHOR_EMAIL: "orc@test.invalid", GIT_COMMITTER_NAME: "orc test", GIT_COMMITTER_EMAIL: "orc@test.invalid" }
  })
  if (done.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" "))
  }
}

const repoWithChange = async (changed: string): Promise<{ readonly dir: string; readonly branch: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-review-repo-"))
  await gitFixture(dir, ["init", "-q"])
  await writeFile(join(dir, "a.txt"), "base\n")
  await gitFixture(dir, ["add", "a.txt"])
  await gitFixture(dir, ["commit", "-qm", "base"])
  await gitFixture(dir, ["checkout", "-qb", "orc/test"])
  await mkdir(join(dir, changed, ".."), { recursive: true })
  await writeFile(join(dir, changed), "base\nchange\n")
  await gitFixture(dir, ["add", changed])
  await gitFixture(dir, ["commit", "-qm", "work"])
  await gitFixture(dir, ["checkout", "-q", "-"])
  return { dir, branch: "orc/test" }
}

const sessionWith = (reply: string): string =>
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } } }) + "\n"

const stubAgent = (dir: string, replies: ReadonlyArray<string>, runs: Array<AgentRun>): SandboxOps["runAgent"] => (run) =>
  Effect.promise(async () => {
    runs.push(run)
    const sessionFile = join(dir, "review-" + runs.length.toString() + ".jsonl")
    await writeFile(sessionFile, sessionWith(replies[runs.length - 1] ?? ""))
    return { sessionId: null, sessionFile, end: { kind: "exited", exitCode: 0 }, commits: [] }
  })

interface ReviewSetup {
  readonly branch: string
  readonly mode: "direct-PR" | "orc"
  readonly changed: string
  readonly config: string | null
}

const directPr: ReviewSetup = { branch: "orc/test", mode: "direct-PR", changed: "a.txt", config: null }

const review = async (replies: ReadonlyArray<string>, setup: Partial<ReviewSetup> = {}): Promise<{ readonly outcome: ReviewOutcome; readonly runs: ReadonlyArray<AgentRun>; readonly runDir: string; readonly sessionDir: string; readonly saved: string | null; readonly diff: string | null }> => {
  const { branch, mode, changed, config } = { ...directPr, ...setup }
  const runDir = await mkdtemp(join(tmpdir(), "orc-review-"))
  const repo = await repoWithChange(changed)
  const worktreeDir = await mkdtemp(join(tmpdir(), "orc-review-worktree-"))
  if (config !== null) {
    await writeFile(join(worktreeDir, ".no-mistakes.yaml"), config)
  }
  try {
    const runs: Array<AgentRun> = []
    const sessionDir = join(runDir, "session")
    await mkdir(sessionDir, { recursive: true })
    const outcome = await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return yield* runReviewTurn({ fs, path, runDir, piSessionDir: sessionDir, spawner, git: gitBin, projectDir: repo.dir, worktreeDir, branch }, stubAgent(runDir, replies, runs), reviewer, mode)
    }).pipe(Effect.provide(BunServices.layer)))
    const saved = await readFile(join(runDir, "review.json"), "utf8").catch(() => null)
    const diff = await readFile(join(sessionDir, "diff.md"), "utf8").catch(() => null)
    return { outcome, runs, runDir, sessionDir, saved, diff }
  } finally {
    await rm(runDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
    await rm(worktreeDir, { recursive: true, force: true })
  }
}

describe("the direct-PR review turn decodes the reviewer's findings", () => {
  test("multiline failure diagnostics do not split the run end reason", () => {
    expect(reviewSentence({ status: "failed", reason: " \tMissing key\r\n  at [0][\"file\"]\n" })).toBe(
      "The review turn failed, so the review did not pass: Missing key at [0][\"file\"]. "
    )
  })

  test("a readable first answer records its findings in review.json instead of asking again", async () => {
    const { outcome, runs, runDir, sessionDir, saved, diff } = await review([JSON.stringify([finding])])
    expect(runs).toHaveLength(1)
    expect(runs[0]?.agent.kind).toBe("reviewer")
    expect(runs[0]?.agent.tools).toEqual(["read", "grep", "find", "ls"])
    expect(runs[0]?.prompt).toContain("The task sits in " + join(sessionDir, "task.md") + ".")
    expect(runs[0]?.prompt).toContain("The branch diff sits in " + join(sessionDir, "diff.md") + ".")
    expect(diff).toContain("+change")
    expect(outcome).toEqual({ status: "passed", findings: [finding], file: join(runDir, "review.json") })
    expect(JSON.parse(saved ?? "null")).toEqual([finding])
  })

  test("an unreadable answer gets one rerun on the same session, and the readable second answer passes", async () => {
    const { outcome, runs, saved } = await review(["No findings JSON here.", "[]"])
    expect(runs).toHaveLength(2)
    expect(runs[1]?.resumeSession).toEndWith("review-1.jsonl")
    expect(runs[1]?.prompt).toContain("orc could not read your findings")
    expect(outcome).toMatchObject({ status: "passed", findings: [] })
    expect(saved).toBe("[]\n")
  })

  test("two unreadable answers fail the step instead of passing it as an empty review", async () => {
    const { outcome, runs, saved } = await review(["[{\"id\": \"x\"}]", "Still no JSON."])
    expect(runs).toHaveLength(2)
    expect(outcome.status).toBe("failed")
    expect(outcome).not.toHaveProperty("findings")
    expect(saved).toBeNull()
  })

  test("a missing branch fails the review before the reviewer runs instead of reviewing blind", async () => {
    const { outcome, runs, saved } = await review(["[]"], { branch: "orc/missing" })
    expect(runs).toHaveLength(0)
    expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("branch diff") })
    expect(saved).toBeNull()
  })
})

const docsRule = "Flag a page that buries its main point."
const runRule = "The run package reaches another package only through the schema package."

const configWithRules = [
  "commands:",
  "  lint: bun run lint",
  "review:",
  "  path_instructions:",
  "    - path: \"docs/**\"",
  "      instructions: |",
  "        " + docsRule,
  "    - path: \"packages/run/**\"",
  "      instructions: |",
  "        " + runRule,
  ""
].join("\n")

describe("the orc review turn sends the project's path rules for the changed files", () => {
  test("a rule whose glob matches no changed file stays out of the prompt while the matching rule goes in", async () => {
    const { outcome, runs } = await review(["[]"], { mode: "orc", changed: "docs/guide.md", config: configWithRules })
    expect(outcome.status).toBe("passed")
    expect(runs).toHaveLength(1)
    expect(runs[0]?.prompt).toContain("Rule for docs/**:\n" + docsRule)
    expect(runs[0]?.prompt).not.toContain("packages/run/**")
    expect(runs[0]?.prompt).not.toContain(runRule)
  })

  test("a config with no review section sends no path rules instead of failing the review", async () => {
    const { outcome, runs } = await review(["[]"], { mode: "orc", changed: "docs/guide.md", config: "commands:\n  lint: bun run lint\n" })
    expect(outcome.status).toBe("passed")
    expect(runs[0]?.prompt).not.toContain("path rules")
  })

  test("an orc finding without a topic is retried rather than accepted for id matching", async () => {
    const missing = { ...finding, severity: "error" }
    const complete = { ...missing, topic: "stray-comment" }
    const { outcome, runs, saved } = await review([JSON.stringify([missing]), JSON.stringify([complete])], { mode: "orc", config: "commands: {}\n" })
    expect(runs).toHaveLength(2)
    expect(outcome).toMatchObject({ status: "passed", findings: [complete] })
    expect(JSON.parse(saved ?? "null")).toEqual([complete])
  })

  test("a path rule with no instructions fails the review before the reviewer runs instead of dropping the rule", async () => {
    const { outcome, runs, saved } = await review(["[]"], { mode: "orc", changed: "docs/guide.md", config: "review:\n  path_instructions:\n    - path: \"docs/**\"\n" })
    expect(runs).toHaveLength(0)
    expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("path_instructions") })
    expect(saved).toBeNull()
  })
})
