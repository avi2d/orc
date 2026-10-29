import { describe, expect, test } from "bun:test"
import { chmod, exists, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { openCheckout, runAgentStep } from "../../packages/run/src/run"
import { capturedSession, cleanFinish, commitOnBranch, git, passedWithPr, recordedNothing, providerErrorEchoingPrompt, runStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

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

  test("a stopped run's Sandcastle worktree does not count as uncommitted changes and block its resume", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        git(dir, ["worktree", "add", "-q", join(dir, ".sandcastle", "worktrees", "orc-test"), "-b", "orc/test"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
      })
    })
  })

  test("an untracked file beside the Sandcastle worktrees still counts as uncommitted", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await mkdir(join(dir, ".sandcastle"))
        await writeFile(join(dir, ".sandcastle", "notes.txt"), "uncommitted\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("uncommitted changes")
      })
    })
  })

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
  })

  test("a checkout carrying a marker no list names is not refused for it", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, ".slot-owner"), "some-slot\n")
        git(dir, ["add", ".slot-owner"])
        git(dir, ["commit", "-qm", "slot marker"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("cannot read the task file")
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
        await writeFile(join(agentsDir, "fixer.md"), "---\nmodel: acme/coder\nthinking: high\ntools: read\n---\nFix it.\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test", agentsDir })).toContain(join(home, "config.json") + " does not configure the provider for an agent model")
        expect(await exists(runDir)).toBe(false)
      })
    })
  })
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
  })

  test("a matching marker refuses the checkout naming the marker", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, ".slot-owner"), "some-slot\n")
      git(dir, ["add", ".slot-owner"])
      git(dir, ["commit", "-qm", "slot marker"])
      const message = await attempt(dir, [".slot-owner"])
      expect(message).toContain(".slot-owner")
      expect(message).toContain("marks this checkout as refused")
    })
  })
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
        expect(outcome.run?.endReason).toStartWith("Pi's final reply did not stop cleanly with ORC_COMPLETE on its own line. It ended in an error: 400 invalid request: ")
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
        const outcome = await runStep(dir, home, sandboxResult(sha, cleanFinish), async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 }), [passedWithPr, recordedNothing])
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
