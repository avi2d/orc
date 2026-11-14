import { describe, expect, test } from "bun:test"
import { chmod, exists, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { openCheckout } from "../../packages/run/src/entities/task-copy/index"
import { openTaskCopy } from "../../packages/run/src/entities/task-copy/index"
import { runAgentStep } from "../../packages/run/src/features/running-a-task/run"
import { capturedSession, cleanFinish, commitOnBranch, git, passedWithPr, recordedNothing, providerErrorEchoingPrompt, runStep, runStepAs, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const refusal = async (input: {
  readonly cwd: string
  readonly taskFile: string
  readonly home: string
  readonly branch?: string
  readonly agentsDir?: string
}): Promise<string> => {
  const priorBypass = process.env["HEAVY_QUEUE_BYPASS"]
  process.env["HEAVY_QUEUE_BYPASS"] = "e2e fixture without a pueue daemon"
  try {
    return await Effect.runPromise(
      runAgentStep({ cwd: input.cwd, taskFile: input.taskFile, branch: input.branch, homeDir: input.home, runId: "test-run-1", agentsDir: input.agentsDir }).pipe(
        Effect.provide(BunServices.layer),
        Effect.as("ran"),
        Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message))
      )
    )
  } finally {
    if (priorBypass === undefined) {
      delete process.env["HEAVY_QUEUE_BYPASS"]
    } else {
      process.env["HEAVY_QUEUE_BYPASS"] = priorBypass
    }
  }
}

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
  }, 60_000)

  test("a checkout with uncommitted changes is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, "draft.txt"), "uncommitted\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("uncommitted changes")
      })
    })
  }, 60_000)

  test("an old in-checkout copy of a stopped run's branch is reused where it sits with its uncommitted work", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const old = join(dir, ".sandcastle", "worktrees", "orc-test")
        git(dir, ["worktree", "add", "-q", "-b", "orc/test", old])
        await writeFile(join(old, "unsaved.txt"), "work in progress\n")
        const reused = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const checkout = yield* openCheckout(fs, path, spawner, Bun.which("git") ?? "git", dir, "orc/test", "test-run-1", [])
            const copy = yield* openTaskCopy(fs, path, spawner, Bun.which("git") ?? "git", checkout, home)
            return copy.dir
          }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
        )
        expect(reused).toBe(await realpath(old))
        expect(await readFile(join(old, "unsaved.txt"), "utf8")).toBe("work in progress\n")
        expect(git(dir, ["worktree", "list", "--porcelain"])).toContain("branch refs/heads/orc/test")
      })
    })
  }, 60_000)

  test("an untracked file a glob in a nested worktree's folder name would match still counts as uncommitted", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        git(dir, ["worktree", "add", "-q", join(dir, "old*"), "-b", "orc/glob"])
        await writeFile(join(dir, "oldnotes.txt"), "uncommitted\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("uncommitted changes")
      })
    })
  }, 60_000)

  test("an untracked file beside the old in-checkout copies still counts as uncommitted", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await mkdir(join(dir, ".sandcastle"))
        await writeFile(join(dir, ".sandcastle", "notes.txt"), "uncommitted\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("uncommitted changes")
      })
    })
  }, 60_000)

  test("a checkout carrying a refused marker is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, ".slot-owner"), "some-slot\n")
        git(dir, ["add", ".slot-owner"])
        git(dir, ["commit", "-qm", "slot marker"])
        process.env.ORC_REFUSE_MARKERS = ".slot-owner"
        try {
          expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("marks this checkout as refused")
        } finally {
          delete process.env.ORC_REFUSE_MARKERS
        }
      })
    })
  }, 60_000)

  test("a checkout carrying a marker no list names is not refused for it", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, ".slot-owner"), "some-slot\n")
        git(dir, ["add", ".slot-owner"])
        git(dir, ["commit", "-qm", "slot marker"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("cannot read the task file")
      })
    })
  }, 60_000)

  test("an unusable branch name is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "bad..name" })).toContain("no usable branch name")
      })
    })
  }, 60_000)

  test.each(["orc/$USER", "orc/`id`", "orc/$(id)", "orc/a\"b"])("the branch name %p passes the branch checks even when a shell would expand it", async (branch) => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch })).toContain("cannot read the task file")
      })
    })
  }, 60_000)

  test("the branch named after the run id passes the branch checks", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home })).toContain("cannot read the task file")
      })
    })
  }, 60_000)

  test("a missing task file is refused as missing instead of with the file system's raw error", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const missing = join(dir, "missing.md")
        expect(await refusal({ cwd: dir, taskFile: missing, home, branch: "orc/test" })).toBe("orc: cannot read the task file " + missing + ": the file is missing")
      })
    })
  }, 60_000)

  test("a model whose provider config.json does not configure is refused instead of run on a built-in provider", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const agentsDir = join(home, "agents")
        await writeFile(join(dir, "task.md"), "Do nothing.\n")
        git(dir, ["add", "task.md"])
        git(dir, ["commit", "-qm", "task"])
        await mkdir(agentsDir, { recursive: true })
        await writeFile(join(agentsDir, "implementer.md"), "---\nmodel: example.com/other-model\nthinking: low\ntools: read\n---\nDo it.\n")
        await writeFile(join(agentsDir, "fixer.md"), "---\nmodel: acme/coder\nthinking: high\ntools: read\n---\nFix it.\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test", agentsDir })).toContain(join(home, "config.json") + " does not configure the provider for an agent model")
      })
    })
  }, 60_000)

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
        await writeFile(join(agentsDir, "fixer.md"), "---\nmodel: acme/coder\nthinking: high\ntools: read\n---\nFix it.\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test", agentsDir })).toContain(join(home, "config.json") + " does not configure the provider for an agent model")
        expect(await exists(runDir)).toBe(false)
      })
    })
  }, 60_000)
})

describe("openCheckout refuse markers", () => {
  const attempt = (dir: string, markers: ReadonlyArray<string>): Promise<string> =>
    Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        yield* openCheckout(fs, path, spawner, Bun.which("git") ?? "git", dir, "orc/test-markers", "test-run-1", markers)
        return "opened"
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message)))
    )

  test("an empty list opens a checkout carrying a marker file", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, ".slot-owner"), "some-slot\n")
      git(dir, ["add", ".slot-owner"])
      git(dir, ["commit", "-qm", "slot marker"])
      expect(await attempt(dir, [])).toBe("opened")
    })
  }, 60_000)

  test("a matching marker refuses the checkout naming the marker", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, ".slot-owner"), "some-slot\n")
      git(dir, ["add", ".slot-owner"])
      git(dir, ["commit", "-qm", "slot marker"])
      const message = await attempt(dir, [".slot-owner"])
      expect(message).toContain(".slot-owner")
      expect(message).toContain("marks this checkout as refused")
    })
  }, 60_000)
})

describe("runWithHistory decides the implement step", () => {
  test("an over-budget worker returns its split instead of running checks or opening a PR", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const proposal = { schema: "orc.split.v1", plan: "split", reason: "two areas", done: ["both work"], children: [
          { title: "First", body: "Ship the first area.", after: [] },
          { title: "Second", body: "Ship the second area.", after: [1] }
        ] }
        await capturedSession(home, sessionEnding({ role: "assistant", content: [{ type: "text", text: "ORC_SPLIT\n" + JSON.stringify(proposal) }], stopReason: "stop" }))
        const outcome = await runStep(dir, home, async (_run, sessionsDir) => ({ sessionId: "split", sessionFile: join(sessionsDir, "2026-10-19T10-00-00-000Z_0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"), commits: [] }))
        expect(outcome.run?.endReason).toBe("split proposal: " + JSON.stringify(proposal))
        expect(outcome.report.prLink).toBeNull()
        expect(outcome.report.checksRounds).toBeNull()
        expect(outcome.nmCalls).toBe("")
      })
    })
  }, 60_000)

  test("a split that stopped cleanly is accepted even when Pi exited nonzero instead of rejecting on the exit code", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const proposal = { schema: "orc.split.v1", plan: "split", reason: "two areas", done: ["both work"], children: [
          { title: "First", body: "First area.", after: [] }, { title: "Second", body: "Second area.", after: [] }
        ] }
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding({ role: "assistant", content: [{ type: "text", text: "ORC_SPLIT\n" + JSON.stringify(proposal) + "\nORC_COMPLETE" }], stopReason: "stop" }))
        const outcome = await runStep(dir, home, async (_run, sessionsDir) => ({ sessionId: "split", sessionFile: join(sessionsDir, "2026-10-19T10-00-00-000Z_0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"), commits: [{ sha }], exitCode: 1 }))
        expect(outcome.run?.endReason).toBe("split proposal: " + JSON.stringify(proposal))
        expect(outcome.report.checksRounds).toBeNull()
        expect(outcome.report.prLink).toBeNull()
      })
    })
  }, 60_000)

  test("a provider error echoing the prompt is recorded failed even with a new commit", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(providerErrorEchoingPrompt))
        const outcome = await runStep(dir, home, sandboxResult(sha))
        expect(outcome.report.commits?.map((commit) => commit.sha)).toEqual([sha])
        expect(outcome.report.completed).toBe(false)
        expect(outcome.run?.endReason).toStartWith("Pi's final reply did not stop cleanly with ORC_COMPLETE on its own line. It ended in an error: 400 invalid request: ")
        expect(outcome.run?.status).toBe("failed")
        expect(outcome.steps).toEqual([{ name: "implement", status: "failed" }])
      })
    })
  }, 60_000)

  test("a clean final reply with the marker and a new commit runs the checks and is recorded succeeded", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
        const outcome = await runStep(dir, home, sandboxResult(sha), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [passedWithPr, recordedNothing])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.tokens).toEqual({ input: 150, output: 25 })
        expect(outcome.report.fixAttempts).toBe(0)
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([true])
        expect(outcome.run?.status).toBe("succeeded")
        expect(outcome.run?.endReason).toBe("Pi made 1 commit on orc/test, and the checks passed. no-mistakes opened https://github.com/o/r/pull/7 and CI is green.")
        expect(outcome.run?.prLink).toBe("https://github.com/o/r/pull/7")
        expect(outcome.steps).toEqual([{ name: "implement", status: "passed" }, { name: "checks", status: "passed" }, { name: "no-mistakes", status: "passed" }])
      })
    })
  }, 60_000)

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
  }, 60_000)

  test("a run whose Pi session was never captured keeps its commits and records no token counts", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        const outcome = await runStep(dir, home, sandboxResult(sha))
        expect(outcome.report.completed).toBe(false)
        expect(outcome.report.commits?.map((commit) => commit.sha)).toEqual([sha])
        expect(outcome.report.tokens).toBeNull()
        expect(outcome.signals).toEqual([{ name: "commit-count", value: "1" }])
        expect(outcome.evidence).toContain(sha + " work")
        expect(outcome.evidence).not.toContain("0 input tokens")
      })
    })
  }, 60_000)
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
        const outcome = await runStep(dir, home, sandboxResult(sha), async (command) => {
          seen.push(command)
          return { stdout: command + " ok", stderr: "", exitCode: 0 }
        }, [passedWithPr, recordedNothing])
        expect(outcome.report.completed).toBe(true)
        expect(seen).toEqual(["bun run lint", "bun run typecheck"])
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([true])
        expect(outcome.report.fixAttempts).toBe(0)
        const file = outcome.report.checksRounds?.[0]?.file ?? ""
        expect(file.endsWith("checks-1.txt")).toBe(true)
        const text = await readFile(file, "utf8")
        expect(text).toContain("check lint: bun run lint")
        expect(text).toContain("exit 0: passed")
        expect(outcome.steps).toEqual([{ name: "implement", status: "passed" }, { name: "checks", status: "passed" }, { name: "no-mistakes", status: "passed" }])
        expect(outcome.signals).toContainEqual({ name: "check lint", value: "passed" })
        expect(outcome.signals).toContainEqual({ name: "check typecheck", value: "passed" })
      })
    })
  }, 60_000)

  test("a failure fixed on the second round ends completed with one fix attempt", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), yaml)
        let lintRuns = 0
        const agentCalls: Array<string> = []
        const agent = sandboxResult(sha)
        const outcome = await runStep(dir, home, async (run, sessionsDir) => {
          agentCalls.push(run.prompt + " // " + run.logFile)
          return agent(run, sessionsDir)
        }, async (command) => {
          if (command === "bun run lint") {
            lintRuns += 1
            return lintRuns === 1
              ? { stdout: "", stderr: "lint blew up", exitCode: 1 }
              : { stdout: "lint ok", stderr: "", exitCode: 0 }
          }
          return { stdout: "typecheck ok", stderr: "", exitCode: 0 }
        }, [passedWithPr, recordedNothing])
        expect(outcome.report.completed).toBe(true)
        expect(outcome.report.fixAttempts).toBe(1)
        expect(outcome.report.checksRounds?.map((round) => round.passed)).toEqual([false, true])
        expect(outcome.report.checksRounds?.[0]?.failed).toEqual(["lint"])
        expect(outcome.report.fixes.map((fix) => fix.status)).toEqual(["passed"])
        expect(outcome.report.fixes[0]?.evidenceIn.endsWith("checks-1.txt")).toBe(true)
        expect(agentCalls.length).toBe(2)
        expect(agentCalls[1]).toContain("checks-1.txt")
        expect(agentCalls[1]).toContain("fix-1.log")
        expect(outcome.run?.endReason).toBe("Pi made 2 commits on orc/test, and the checks passed. no-mistakes opened https://github.com/o/r/pull/7 and CI is green.")
        expect(outcome.steps).toEqual([
          { name: "implement", status: "passed" },
          { name: "checks", status: "failed" },
          { name: "fix", status: "passed" },
          { name: "checks", status: "passed" },
          { name: "no-mistakes", status: "passed" }
        ])
        const report = await readFile(join(home, "runs", "step-run-1", "report.md"), "utf8")
        const steps = report.split("## Steps")[1]?.split("## Evidence")[0]?.trim().split("\n").map((line) => line.split(":")[0])
        expect(steps).toEqual(["- implement", "- checks round 1", "- fix 1", "- checks round 2", "- no-mistakes"])
      })
    })
  }, 60_000)

  test("three failed fix attempts end the run naming the failing check and its output, with no PR", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const sha = await commitOnBranch(dir, "orc/test")
        await capturedSession(home, sessionEnding(cleanFinish))
        await writeFile(join(dir, ".no-mistakes.yaml"), yaml)
        let agentRuns = 0
        const agent = sandboxResult(sha)
        const outcome = await runStep(dir, home, async (run, sessionsDir) => {
          agentRuns += 1
          return agent(run, sessionsDir)
        }, async (command) =>
          command === "bun run lint"
            ? { stdout: "", stderr: "lint blew up", exitCode: 1 }
            : { stdout: "typecheck ok", stderr: "", exitCode: 0 })
        expect(agentRuns).toBe(4)
        expect(outcome.nmCalls).toBe("")
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
  }, 60_000)
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
  }, 60_000)
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
  test("orc's checkout status runs no repository filter, whatever its driver name", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const filter = await markerScript(home, "filter")
        await plantFilter(dir, join(dir, ".git"), "seed.txt", filter.script)
        backdate(join(dir, "seed.txt"))
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("filter.planted.by.sandbox.clean")
        expect(await filter.ran()).toBe(false)
        backdate(join(dir, "seed.txt"))
        plainGit(dir, ["status", "--porcelain"])
        expect(await filter.ran()).toBe(true)
      })
    })
  }, 60_000)

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
  }, 30_000)
})

describe("host git runs no transport program the sandbox can name in the repository", () => {
  test("a planted ssh command is refused before orc's git runs it", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const ssh = await markerScript(home, "ssh")
        git(dir, ["config", "core.sshCommand", ssh.script])
        git(dir, ["remote", "add", "origin", "ssh://git.example.invalid/repo.git"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("core.sshcommand")
        expect(await ssh.ran()).toBe(false)
        plainGit(dir, ["fetch", "origin", "orc/test"])
        expect(await ssh.ran()).toBe(true)
      })
    })
  }, 60_000)

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
  }, 60_000)

  test("a repository whose config names only a remote and an identity still runs", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        git(dir, ["remote", "add", "origin", "https://example.invalid/repo.git"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
      })
    })
  }, 60_000)
})

describe("orc run records where and with what it ran", () => {
  test("a task run records its task, machine and worktree and the implement step's model and thinking instead of leaving them null", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const proposal = { schema: "orc.split.v1", plan: "split", reason: "two areas", done: ["both work"], children: [
          { title: "First", body: "First area.", after: [] }, { title: "Second", body: "Second area.", after: [] }
        ] }
        await capturedSession(home, sessionEnding({ role: "assistant", content: [{ type: "text", text: "ORC_SPLIT\n" + JSON.stringify(proposal) }], stopReason: "stop" }))
        const outcome = await runStepAs(dir, home, async (_run, sessionsDir) => ({ sessionId: "split", sessionFile: join(sessionsDir, "2026-10-19T10-00-00-000Z_0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"), commits: [] }), { branch: "orc/orc-36", machine: "linux" })
        expect(outcome.run).toMatchObject({ task: "orc-36", machine: "linux", worktree: dir })
        expect(outcome.stepAgents).toEqual([{ name: "implement", model: "acme/coder", thinking: "high" }])
      })
    })
  }, 60_000)
})
