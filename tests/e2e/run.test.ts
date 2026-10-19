import { describe, expect, test } from "bun:test"
import { chmod, exists, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../src/agents"
import { hostGitShim } from "../../src/host"
import { orcCompletionLine } from "../../src/pi"
import { runAgentStep, runWithHistory, type SandboxOps } from "../../src/run"
import type { OrcRunReport } from "../../src/run-record"
import { listRuns, openDatabase, type RunRecord } from "../../src/run-history"

const git = (dir: string, args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" "))
  }
  return result.stdout.toString().trim()
}

const withRepo = async (use: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-run-unit-"))
  try {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.name", "orc test"])
    git(dir, ["config", "user.email", "orc@test.invalid"])
    await writeFile(join(dir, "seed.txt"), "seed\n")
    git(dir, ["add", "seed.txt"])
    git(dir, ["commit", "-qm", "seed"])
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-run-home-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const refusal = (input: {
  readonly cwd: string
  readonly taskFile: string
  readonly home: string
  readonly branch?: string
  readonly agentsDir?: string
}): Promise<string> =>
  Effect.runPromise(
    runAgentStep({ cwd: input.cwd, taskFile: input.taskFile, branch: input.branch, homeDir: input.home, runId: "test-run-1", agentsDir: input.agentsDir }).pipe(
      Effect.provide(BunServices.layer),
      Effect.as("ran"),
      Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message))
    )
  )

describe("runAgentStep refusals", () => {
  test("a directory in no git checkout is refused", async () => {
    await withHome(async (home) => {
      const dir = await mkdtemp(join(tmpdir(), "orc-run-plain-"))
      try {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("sits in no git checkout")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  test("a checkout with uncommitted changes is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, "draft.txt"), "uncommitted\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("uncommitted changes")
      })
    })
  })

  test("a firstmate checkout is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, ".fm-slot-owner"), "some-slot\n")
        git(dir, ["add", ".fm-slot-owner"])
        git(dir, ["commit", "-qm", "slot marker"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("firstmate checkout")
      })
    })
  })

  test("an unusable branch name is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "bad..name" })).toContain("no usable branch name")
      })
    })
  })

  test("a branch name the host shell would expand is refused, naming it", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        for (const branch of ["orc/$USER", "orc/`id`", "orc/$(id)", "orc/a\"b"]) {
          const message = await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch })
          expect(message).toContain(branch)
          expect(message).toContain("shell metacharacter")
        }
      })
    })
  })

  test("the branch named after the run id passes the branch checks", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home })).toContain("cannot read the task file")
      })
    })
  })

  test("a missing task file is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
      })
    })
  })

  test("a model orc cannot route is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const agentsDir = join(home, "agents")
        await writeFile(join(dir, "task.md"), "Do nothing.\n")
        git(dir, ["add", "task.md"])
        git(dir, ["commit", "-qm", "task"])
        await mkdir(agentsDir, { recursive: true })
        await writeFile(join(agentsDir, "implementer.md"), "---\nmodel: example.com/other-model\nthinking: low\ntools: read\n---\nDo it.\n")
        await writeFile(join(agentsDir, "fixer.md"), "---\nmodel: opencode-go/muse-spark\nthinking: high\ntools: read\n---\nFix it.\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test", agentsDir })).toContain("routes only opencode-go models")
      })
    })
  })

  test("a run refused after its run folder is made leaves no run folder behind", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const runDir = join(home, "runs", "test-run-1")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
        expect(await exists(runDir)).toBe(false)
        const agentsDir = join(home, "agents")
        await writeFile(join(dir, "task.md"), "Do nothing.\n")
        git(dir, ["add", "task.md"])
        git(dir, ["commit", "-qm", "task"])
        await mkdir(agentsDir, { recursive: true })
        await writeFile(join(agentsDir, "implementer.md"), "---\nmodel: example.com/other-model\nthinking: low\ntools: read\n---\nDo it.\n")
        await writeFile(join(agentsDir, "fixer.md"), "---\nmodel: opencode-go/muse-spark\nthinking: high\ntools: read\n---\nFix it.\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test", agentsDir })).toContain("routes only opencode-go models")
        expect(await exists(runDir)).toBe(false)
      })
    })
  })
})

const implementer: AgentFile = {
  kind: "implementer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read", "bash"],
  body: "Do the task.",
  path: "bundled/implementer.md",
  source: "bundled"
}

const sessionId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const prompt = "Read the task. When the work is committed on this branch, print " + orcCompletionLine + " on its own line and stop."

const entry = (message: Record<string, unknown>): string => JSON.stringify({ type: "message", message })

const sessionEnding = (final: Record<string, unknown>): string =>
  [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-10-19T10:00:00.000Z", cwd: "/sandbox/repo" }),
    entry({ role: "user", content: [{ type: "text", text: prompt }] }),
    entry({
      role: "assistant",
      content: [{ type: "text", text: "Plan, then print\n" + orcCompletionLine }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git commit -am work" } }],
      stopReason: "toolUse",
      usage: { input: 100, output: 20 }
    }),
    entry({ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "[orc/test 1a2b3c4] work" }], isError: false }),
    entry(final)
  ].join("\n") + "\n"

const providerErrorEchoingPrompt = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 invalid request: " + prompt, usage: { input: 0, output: 0 } }

const cleanFinish = { role: "assistant", content: [{ type: "text", text: "Committed.\n" + orcCompletionLine }], stopReason: "stop", rawStopReason: "completed", usage: { input: 50, output: 5 } }

const commitOnBranch = async (dir: string, branch: string): Promise<string> => {
  git(dir, ["checkout", "-q", "-b", branch])
  await writeFile(join(dir, "work.txt"), "work\n")
  git(dir, ["add", "work.txt"])
  git(dir, ["commit", "-qm", "work"])
  const sha = git(dir, ["rev-parse", "HEAD"])
  git(dir, ["checkout", "-q", "-"])
  return sha
}

interface StepOutcome {
  readonly report: OrcRunReport
  readonly run: RunRecord | undefined
  readonly steps: unknown
  readonly signals: unknown
  readonly evidence: string
}

const unexpectedChecks: SandboxOps["execCheck"] = async () => {
  throw new Error("checks ran before implement completed")
}

const runStep = (dir: string, home: string, sandbox: SandboxOps["runAgent"], execCheck: SandboxOps["execCheck"] = unexpectedChecks): Promise<StepOutcome> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const runDir = path.join(home, "runs", "step-run-1")
      yield* fs.makeDirectory(path.join(runDir, "sessions"), { recursive: true })
      const hostGit = yield* hostGitShim(fs, path, Bun.which("git") ?? "git")
      return yield* Effect.acquireUseRelease(
        openDatabase(home),
        (db) =>
          Effect.gen(function*() {
            const report = yield* runWithHistory(db, {
              fs, path, spawner, git: hostGit, projectDir: dir, runId: "step-run-1", runDir,
              piSessionDir: path.join(runDir, "session"), hostSessionsDir: path.join(runDir, "sessions"),
              taskPath: path.join(runDir, "task.md"), agent: implementer, fixer, branch: "orc/test", started: "2026-10-19T10:00:00.000Z",
              worktreeDir: dir
            }, { runAgent: sandbox, execCheck })
            const runs = yield* listRuns(db)
            const steps = db.query("SELECT name, status FROM steps WHERE run_id = ?").all("step-run-1")
            const signals = db.query("SELECT name, value FROM signals ORDER BY name").all()
            const evidence = yield* fs.readFileString(path.join(runDir, "implement-1.md"))
            return { report, run: runs.find((run) => run.id === "step-run-1"), steps, signals, evidence }
          }),
        (db) => Effect.sync(() => db.close())
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

const fixer: AgentFile = {
  kind: "fixer",
  model: "opencode-go/muse-spark",
  thinking: "high",
  tools: ["read", "bash"],
  body: "Fix the failure.",
  path: "bundled/fixer.md",
  source: "bundled"
}

const capturedSession = (home: string, jsonl: string): Promise<void> => {
  const dir = join(home, "runs", "step-run-1", "sessions", "--sandbox-repo--")
  return mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, "2026-10-19T10-00-00-000Z_" + sessionId + ".jsonl"), jsonl))
}

const sandboxResult = (sha: string, final: Record<string, unknown>): SandboxOps["runAgent"] => async () => ({
  iterations: [{ sessionId }],
  completionSignal: orcCompletionLine,
  stdout: JSON.stringify({ type: "message_end", message: final }),
  commits: [{ sha }]
})

describe("runWithHistory decides the implement step", () => {
  test("a provider error echoing the prompt is recorded failed even with a new commit", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(providerErrorEchoingPrompt))
        const outcome = await runStep(dir, home, sandboxResult(sha, providerErrorEchoingPrompt))
        expect(outcome.report.commits?.map((commit) => commit.sha)).toEqual([sha])
        expect(outcome.report.completed).toBe(false)
        expect(outcome.run?.status).toBe("failed")
        expect(outcome.steps).toEqual([{ name: "implement", status: "failed" }])
      })
    })
  })

  test("a clean final reply with the marker and a new commit runs the checks and is recorded succeeded", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }))
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.tokens).toEqual({ input: 150, output: 25 })
        expect(outcome.report.fixAttempts).toBe(0)
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([true])
        expect(outcome.run?.status).toBe("succeeded")
        expect(outcome.run?.endReason).toBe("Pi made 1 commit on orc/test, and the checks passed.")
        expect(outcome.steps).toEqual([{ name: "implement", status: "passed" }, { name: "checks", status: "passed" }])
      })
    })
  })

  test("an agent run that rejects is recorded failed with its reason and evidence", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const outcome = await runStep(dir, home, async () => {
          throw new Error("pi exited with code 1")
        })
        expect(outcome.report.completed).toBe(false)
        expect(outcome.run?.status).toBe("failed")
        expect(outcome.run?.endReason ?? "").toContain("pi exited with code 1")
        expect(outcome.steps).toEqual([{ name: "implement", status: "failed" }])
        expect(outcome.evidence).toContain("pi exited with code 1")
        expect(outcome.evidence).not.toContain("made no commit")
        expect(outcome.signals).toEqual([])
      })
    })
  })

  test("a run whose Pi session was never captured keeps its commits and records no token counts", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish))
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.commits?.map((commit) => commit.sha)).toEqual([sha])
        expect(outcome.report.tokens).toBeNull()
        expect(outcome.signals).toEqual([{ name: "commit-count", value: "1" }])
        expect(outcome.evidence).toContain(sha + " work")
        expect(outcome.evidence).not.toContain("0 input tokens")
      })
    })
  })
})

describe("runWithHistory runs the project checks and fixes failures", () => {
  const yaml = "commands:\n  lint: bun run lint\n  typecheck: bun run typecheck\n"

  test("a passing checks run records the round, its evidence file and its signals", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), yaml)
        const seen: Array<string> = []
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async (command) => {
          seen.push(command)
          return { stdout: command + " ok", stderr: "", exitCode: 0 }
        })
        expect(outcome.report.completed).toBe(true)
        expect(seen).toEqual(["bun run lint", "bun run typecheck"])
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([true])
        expect(outcome.report.fixAttempts).toBe(0)
        const file = outcome.report.checksRounds?.[0]?.file ?? ""
        expect(file.endsWith("checks-1.txt")).toBe(true)
        const text = await readFile(file, "utf8")
        expect(text).toContain("check lint: bun run lint")
        expect(text).toContain("exit 0: passed")
        expect(outcome.steps).toEqual([{ name: "implement", status: "passed" }, { name: "checks", status: "passed" }])
        expect(outcome.signals).toContainEqual({ name: "check lint", value: "passed" })
        expect(outcome.signals).toContainEqual({ name: "check typecheck", value: "passed" })
      })
    })
  })

  test("a failure fixed on the second round ends completed with one fix attempt", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), yaml)
        let lintRuns = 0
        const agentCalls: Array<string> = []
        const agent = sandboxResult(sha, cleanFinish)
        const outcome = await runStep(dir, home, async (provider, seen, logFile) => {
          agentCalls.push(seen + " // " + logFile)
          return agent(provider, seen, logFile)
        }, async (command) => {
          if (command === "bun run lint") {
            lintRuns += 1
            return lintRuns === 1
              ? { stdout: "", stderr: "lint blew up", exitCode: 1 }
              : { stdout: "lint ok", stderr: "", exitCode: 0 }
          }
          return { stdout: "typecheck ok", stderr: "", exitCode: 0 }
        })
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.fixAttempts).toBe(1)
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([false, true])
        expect(outcome.report.checksRounds?.[0]?.failed).toEqual(["lint"])
        expect(outcome.report.fixes.map((fix) => fix.status)).toEqual(["passed"])
        expect(outcome.report.fixes[0]?.evidenceIn.endsWith("checks-1.txt")).toBe(true)
        expect(agentCalls.length).toBe(2)
        expect(agentCalls[1]).toContain("checks-1.txt")
        expect(agentCalls[1]).toContain("fix-1.log")
        expect(outcome.run?.endReason).toBe("Pi made 2 commits on orc/test, and the checks passed.")
        expect(outcome.steps).toHaveLength(4)
        expect(outcome.steps).toEqual(expect.arrayContaining([
          { name: "implement", status: "passed" },
          { name: "checks", status: "failed" },
          { name: "fix", status: "passed" },
          { name: "checks", status: "passed" }
        ]))
      })
    })
  })

  test("three failed fix attempts end the run naming the failing check and its output, with no PR", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), yaml)
        let agentRuns = 0
        const agent = sandboxResult(sha, cleanFinish)
        const outcome = await runStep(dir, home, async (provider, seen, logFile) => {
          agentRuns += 1
          return agent(provider, seen, logFile)
        }, async (command) =>
          command === "bun run lint"
            ? { stdout: "", stderr: "lint blew up", exitCode: 1 }
            : { stdout: "typecheck ok", stderr: "", exitCode: 0 })
        expect(agentRuns).toBe(4)
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.fixAttempts).toBe(3)
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([false, false, false, false])
        expect(outcome.report.fixes.map((fix) => fix.attempt)).toEqual([1, 2, 3])
        const reason = outcome.run?.endReason ?? ""
        expect(reason).toContain("lint")
        expect(reason).toContain("checks-4.txt")
        expect(reason).toContain("No PR opens")
        expect(outcome.run?.status).toBe("failed")
        expect(outcome.run?.prLink).toBeNull()
        expect(outcome.report.checksRounds?.[3]?.file.endsWith("checks-4.txt")).toBe(true)
        const text = await readFile(outcome.report.checksRounds?.[3]?.file ?? "", "utf8")
        expect(text).toContain("lint blew up")
      })
    })
  })
})

const markerScript = async (dir: string, name: string): Promise<{ readonly script: string; readonly ran: () => Promise<boolean> }> => {
  const script = join(dir, name)
  const marker = join(dir, name + "-ran")
  await writeFile(script, "#!/bin/sh\ntouch '" + marker + "'\n")
  await chmod(script, 0o755)
  return { script, ran: () => Bun.file(marker).exists() }
}

const plainGit = (cwd: string, args: ReadonlyArray<string>): void => {
  Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env }, stdout: "ignore", stderr: "ignore" })
}

describe("host git ignores programs the sandbox can name in the repository", () => {
  test("Sandcastle's host git during the run runs no repository fsmonitor or hook", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const fsmonitor = await markerScript(home, "fsmonitor")
        const hook = await markerScript(home, "post-checkout")
        git(dir, ["config", "core.fsmonitor", fsmonitor.script])
        await mkdir(join(dir, ".git", "hooks"), { recursive: true })
        await Bun.write(join(dir, ".git", "hooks", "post-checkout"), Bun.file(hook.script))
        await chmod(join(dir, ".git", "hooks", "post-checkout"), 0o755)
        const outcome = await runStep(dir, home, async () => {
          plainGit(dir, ["status", "--porcelain"])
          plainGit(dir, ["worktree", "add", "-q", join(home, "sandcastle-worktree"), "-b", "orc/test"])
          return { iterations: [], stdout: "", commits: [], branch: "orc/test" }
        })
        expect(outcome.report.completed).toBe(false)
        expect(await fsmonitor.ran()).toBe(false)
        expect(await hook.ran()).toBe(false)
        plainGit(dir, ["status", "--porcelain"])
        plainGit(dir, ["worktree", "add", "-q", join(home, "after-worktree"), "-b", "orc/after"])
        expect(await fsmonitor.ran()).toBe(true)
        expect(await hook.ran()).toBe(true)
      })
    })
  })

  test("orc's own checkout status runs no repository fsmonitor", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const fsmonitor = await markerScript(home, "fsmonitor")
        git(dir, ["config", "core.fsmonitor", fsmonitor.script])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("core.fsmonitor")
        expect(await fsmonitor.ran()).toBe(false)
        plainGit(dir, ["status", "--porcelain"])
        expect(await fsmonitor.ran()).toBe(true)
      })
    })
  })
})

const plantFilter = async (dir: string, gitDir: string, file: string, script: string): Promise<void> => {
  git(dir, ["config", "filter.planted.by.sandbox.clean", script])
  git(dir, ["config", "filter.planted.by.sandbox.smudge", script])
  await mkdir(join(gitDir, "info"), { recursive: true })
  await writeFile(join(gitDir, "info", "attributes"), file + " filter=planted.by.sandbox\n")
}

const backdate = (file: string): void => {
  Bun.spawnSync(["touch", "-m", "-t", "202001010000", file])
}

describe("host git runs no filter the sandbox can name in the repository", () => {
  test("orc's checkout status and Sandcastle's host git run no repository filter, whatever its driver name", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const filter = await markerScript(home, "filter")
        await plantFilter(dir, join(dir, ".git"), "seed.txt", filter.script)
        backdate(join(dir, "seed.txt"))
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("filter.planted.by.sandbox.clean")
        expect(await filter.ran()).toBe(false)
        backdate(join(dir, "seed.txt"))
        const outcome = await runStep(dir, home, async () => {
          plainGit(dir, ["status", "--porcelain"])
          plainGit(dir, ["worktree", "add", "-q", join(home, "sandcastle-worktree"), "-b", "orc/test"])
          return { iterations: [], stdout: "", commits: [], branch: "orc/test" }
        })
        expect(outcome.report.completed).toBe(false)
        expect(await filter.ran()).toBe(false)
        backdate(join(dir, "seed.txt"))
        plainGit(dir, ["status", "--porcelain"])
        expect(await filter.ran()).toBe(true)
      })
    })
  })

  test("orc's checkout status runs no filter a submodule's own config names", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const upstream = join(home, "upstream")
        await mkdir(upstream)
        git(upstream, ["init", "-q"])
        git(upstream, ["config", "user.name", "orc test"])
        git(upstream, ["config", "user.email", "orc@test.invalid"])
        await writeFile(join(upstream, "inner.txt"), "inner\n")
        git(upstream, ["add", "inner.txt"])
        git(upstream, ["commit", "-qm", "inner"])
        git(dir, ["-c", "protocol.file.allow=always", "submodule", "-q", "add", upstream, "sm"])
        git(dir, ["config", "--file", ".gitmodules", "submodule.sm.ignore", "none"])
        git(dir, ["add", ".gitmodules"])
        git(dir, ["commit", "-qm", "submodule"])
        const filter = await markerScript(home, "filter")
        await plantFilter(join(dir, "sm"), join(dir, ".git", "modules", "sm"), "inner.txt", filter.script)
        backdate(join(dir, "sm", "inner.txt"))
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
        expect(await filter.ran()).toBe(false)
        plainGit(dir, ["status", "--porcelain"])
        expect(await filter.ran()).toBe(true)
      })
    })
  })
})

describe("host git runs no transport program the sandbox can name in the repository", () => {
  test("a planted ssh command is refused before orc's git and Sandcastle's fetch run it", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const ssh = await markerScript(home, "ssh")
        git(dir, ["config", "core.sshCommand", ssh.script])
        git(dir, ["remote", "add", "origin", "ssh://git.example.invalid/repo.git"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("core.sshcommand")
        const outcome = await runStep(dir, home, async () => {
          plainGit(dir, ["fetch", "origin", "orc/test"])
          return { iterations: [], stdout: "", commits: [], branch: "orc/test" }
        })
        expect(outcome.report.completed).toBe(false)
        expect(await ssh.ran()).toBe(false)
        plainGit(dir, ["fetch", "origin", "orc/test"])
        expect(await ssh.ran()).toBe(true)
      })
    })
  })

  test("a planted upload-pack program for a local remote is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const uploadPack = await markerScript(home, "upload-pack")
        git(dir, ["remote", "add", "origin", dir])
        git(dir, ["config", "remote.origin.uploadpack", uploadPack.script])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("remote.origin.uploadpack")
        expect(await uploadPack.ran()).toBe(false)
        plainGit(dir, ["fetch", "origin"])
        expect(await uploadPack.ran()).toBe(true)
      })
    })
  })

  test("a repository whose config names only a remote and an identity still runs", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        git(dir, ["remote", "add", "origin", "https://example.invalid/repo.git"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
      })
    })
  })
})
