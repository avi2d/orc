import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Effect, Exit } from "effect"
import { listRuns, openQuestionsForRun, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"
import { stepsForRun } from "../../packages/run/src/entities/run-history/index"
import { recordFixDone, recordFixStart, recordResumePublish } from "../../packages/run/src/features/running-a-task/history-write"
import { buildResumePlan } from "../../packages/run/src/features/running-a-task/run-resume"
import { carriedHoldReleaseId, holdReleaseId } from "../../packages/run/src/entities/review-gate/index"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"
import { runFull } from "../../packages/run/src/features/running-a-task/run-loop"
import type { AgentRun, RunCheckpoints } from "../../packages/run/src/features/running-a-task/run-ops"
import { fakeOps } from "../lib/fake-ops"
import { fixer, historyFor, implementer, openDb, runLoopCheckpoints, seedRefusedPrior, stubGit, stubNoMistakesBin, withHome } from "../lib/run-loop-helpers"

describe("resumed runs publish inherited progress atomically", () => {
  test("the new attempt records its run row and every inherited step together", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        await seedRefusedPrior(db, join(home, "runs", "prior-a"), project)
        const run = await Effect.runPromise(historyFor("next-b", home, project, "2026-10-19T10:00:00.000Z", git, ""))
          const plan = await Effect.runPromise(buildResumePlan(db, run))
          expect(plan.skipImplement).toBe(true)
          expect(plan.skipChecks).toBe(true)
          expect(plan.inheritedRounds.length).toBe(1)
          expect(plan.inheritedFixes.length).toBe(1)
          await Effect.runPromise(recordResumePublish(db, run, plan))
          const runs = await Effect.runPromise(listRuns(db))
          expect(runs.find((known) => known.id === "next-b")?.status).toBe("running")
          const steps = await Effect.runPromise(stepsForRun(db, "next-b"))
          expect(steps.find((step) => step.name === "implement")).toMatchObject({ status: "passed", piSessionFile: plan.implementSessionFile })
          expect(steps.find((step) => step.name === "checks")).toMatchObject({ status: "passed" })
          expect(steps.find((step) => step.name === "fix")).toMatchObject({ status: "passed" })
          expect(steps.some((step) => step.status === "running")).toBe(false)
        } finally {
          db.close()
        }
    })
  })

  test("a resumed run never marks skipped work running", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        await seedRefusedPrior(db, join(home, "runs", "prior-a"), project)
        const bin = await stubNoMistakesBin(home)
        const run = await Effect.runPromise(historyFor(
          "next-b", home, project, "2026-10-19T10:00:00.000Z", git,
          bin + ":" + (process.env.PATH ?? "")
        ))
          await mkdir(run.runDir, { recursive: true })
          await writeFile(join(run.runDir, "task.md"), "Do the thing.\n")
          const plan = await Effect.runPromise(buildResumePlan(db, run))
          await Effect.runPromise(recordResumePublish(db, run, plan))
          const calls = { implementStart: 0, implementDone: 0, agent: 0, checks: 0 }
          const ops = fakeOps({
            runAgent: async () => {
              calls.agent += 1
              throw new Error("the agent ran despite skipped work")
            },
            execCheck: async () => {
              calls.checks += 1
              return { stdout: "", stderr: "", exitCode: 0 }
            }
          }, run.hostSessionsDir)
          const real = runLoopCheckpoints(db, run)
          const checkpoints: RunCheckpoints = {
            ...real,
            implementStart: (started) =>
              Effect.tap(real.implementStart(started), () => Effect.sync(() => { calls.implementStart += 1 })),
            implementDone: (outcome, started, ended) =>
              Effect.tap(real.implementDone(outcome, started, ended), () => Effect.sync(() => { calls.implementDone += 1 }))
          }
          const report = await Effect.runPromise(runFull(run, ops, plan, checkpoints))
          expect(calls.implementStart).toBe(0)
          expect(calls.implementDone).toBe(0)
          expect(calls.agent).toBe(0)
          expect(calls.checks).toBe(0)
          expect(report.completed).toBe(true)
          expect(report.checksRounds?.length).toBe(1)
          expect(report.fixes.length).toBe(1)
        } finally {
          db.close()
        }
    })
  })

  test("inherited steps keep the prior run's agent facts when the current agents differ, instead of the current run's", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        await seedRefusedPrior(db, join(home, "runs", "prior-a"), project)
        const base = await Effect.runPromise(historyFor("next-b", home, project, "2026-10-19T10:00:00.000Z", git, ""))
        const run: HistoryRun = {
          ...base,
          agent: { ...implementer, model: "other/implementer", thinking: "low", path: "bundled/other-implementer.md" },
          fixer: { ...fixer, model: "other/fixer", thinking: "low", path: "bundled/other-fixer.md" }
        }
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        await Effect.runPromise(recordResumePublish(db, run, plan))
        const steps = await Effect.runPromise(stepsForRun(db, "next-b"))
        expect(steps.find((step) => step.name === "implement")).toMatchObject({ agentFile: implementer.path, model: implementer.model, thinking: implementer.thinking })
        expect(steps.find((step) => step.name === "fix")).toMatchObject({ agentFile: fixer.path, model: fixer.model, thinking: fixer.thinking })
      } finally {
        db.close()
      }
    })
  })

  test("a retried inherited fix records the current fixer instead of the inherited agent facts", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        await Effect.runPromise(recordRun(db, {
          id: "next-b", project, branch: "orc/test", taskFile: join(home, "task.md"),
          status: "running", started: "2026-10-19T10:00:00.000Z"
        }).pipe(Effect.asVoid))
        await Effect.runPromise(recordStep(db, {
          runId: "next-b", name: "fix", attempt: 1, status: "failed",
          started: "2026-10-19T09:22:00.000Z", agentFile: "bundled/old-fixer.md",
          piSessionFile: null, model: "old/fixer", thinking: "low"
        }).pipe(Effect.asVoid))
        const current = { ...fixer, model: "other/fixer", thinking: "low" as const, path: "bundled/other-fixer.md" }
        await Effect.runPromise(recordFixStart(db, "next-b", 1, current, "2026-10-19T10:01:00.000Z"))
        await Effect.runPromise(recordFixDone(db, "next-b", {
          attempt: 1, status: "passed",
          started: "2026-10-19T10:01:00.000Z", ended: "2026-10-19T10:02:00.000Z",
          agentFile: current.path, sessionFile: null, model: current.model, thinking: current.thinking,
          evidenceIn: join(home, "checks-1.md"), commits: 1, tokens: null
        }))
        const steps = await Effect.runPromise(stepsForRun(db, "next-b"))
        expect(steps.find((step) => step.name === "fix")).toMatchObject({ agentFile: current.path, model: current.model, thinking: current.thinking })
      } finally {
        db.close()
      }
    })
  })
})

describe("a run sent back with the captain's review", () => {
  test("resumes the passed implement session with the review and reruns checks, instead of inheriting the finished work", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        await writeFile(join(project, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
        const git = await stubGit(home)
        const priorDir = join(home, "runs", "prior-a")
        await seedRefusedPrior(db, priorDir, project)
        const bin = await stubNoMistakesBin(home)
        const base = await Effect.runPromise(historyFor("next-b", home, project, "2026-10-19T10:00:00.000Z", git, bin + ":" + (process.env.PATH ?? "")))
        const run: HistoryRun = { ...base, answers: [{ question: "send-back", answer: "rename the flag" }, { question: "send-back-2", answer: "and its help" }] }
        await mkdir(run.runDir, { recursive: true })
        await writeFile(run.taskPath, "Do the thing.\n")
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan).toMatchObject({ skipImplement: false, skipChecks: false, inheritedRounds: [], inheritedFixes: [], fixSessionFile: null })
        expect(plan.implementSessionFile).not.toBeNull()
        await Effect.runPromise(recordResumePublish(db, run, plan))
        const runs: Array<AgentRun> = []
        let checks = 0
        const ops = fakeOps({
          runAgent: async (agentRun) => {
            runs.push(agentRun)
            await mkdir(run.hostSessionsDir, { recursive: true })
            await writeFile(join(run.hostSessionsDir, "2026-10-19T10-01-00-000Z_sent.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "renamed\nORC_COMPLETE" }] } }) + "\n")
            return { sessionId: "sent", commits: [{ sha: "c3" }] }
          },
          execCheck: async () => {
            checks += 1
            return { stdout: "", stderr: "", exitCode: 0 }
          }
        }, run.hostSessionsDir)
        const report = await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
        expect(report.implementPassed).toBe(true)
        expect(report.checksRounds?.length).toBe(1)
        expect(runs.length).toBe(1)
        expect(runs[0]?.resumeSession).toBe(plan.implementSessionFile ?? "")
        expect(runs[0]?.prompt).toContain("sent it back: rename the flag\nThe captain also wrote: and its help\n")
        expect(checks).toBeGreaterThan(0)
      } finally {
        db.close()
      }
    })
  }, 20_000)
})

const freshPlan = { implementSessionId: null, implementSessionFile: null, inheritedImplement: null, skipImplement: false, skipChecks: false, allow: [], answers: [], inheritedRounds: [], inheritedFixes: [], fixSessionId: null, fixSessionFile: null, fixRunning: false, handover: null, priorDir: null, cleanupPriorDir: null }

const looping = { kind: "looping", label: "bun run test" } as const

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

const answerOnceAsked = async (runDir: string, answer: string): Promise<void> => {
  for (;;) {
    const text = await readFile(join(runDir, "asking.json"), "utf8").catch(() => null)
    if (text !== null) {
      const asking: unknown = JSON.parse(text)
      if (typeof asking === "object" && asking !== null && "asked" in asking) {
        await writeFile(join(runDir, "answers.json"), JSON.stringify({ asking: asking.asked, answers: [{ question: "looping", answer }] }))
        return
      }
    }
    await Bun.sleep(10)
  }
}

describe("a run Pi loops in", () => {
  test("asks the captain on the step and ends unfinished when no answer comes, instead of reading the stop as done", async () => {
    await withLoopRun(0, async (db, run) => {
      let calls = 0
      const ops = fakeOps({
        runAgent: async () => {
          calls += 1
          return { end: looping, commits: [] }
        },
        execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      }, run.hostSessionsDir)
      const report = await Effect.runPromise(runFull(run, ops, freshPlan, runLoopCheckpoints(db, run)))
      expect(calls).toBe(1)
      expect(report.implementPassed).toBe(false)
      expect(report.checksRounds).toBeNull()
      const asked = await Effect.runPromise(openQuestionsForRun(db, run.runId))
      expect(asked).toMatchObject([{ id: "looping", text: expect.stringContaining("Pi failed bun run test 6 times in a row"), owner: "user" }])
    })
  })

  test("resumes the same Pi session with the captain's guidance on continue, instead of starting Pi afresh", async () => {
    await withLoopRun(30, async (db, run) => {
      const runs: Array<AgentRun> = []
      const ops = fakeOps({
        runAgent: async (agentRun) => {
          runs.push(agentRun)
          if (runs.length === 1) {
            void answerOnceAsked(run.runDir, "Continue, run one test file at a time")
            return { end: looping, sessionFile: "/sessions/first.jsonl", commits: [{ sha: "a1" }] }
          }
          return { commits: [{ sha: "b2" }] }
        },
        execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      }, run.hostSessionsDir)
      await Effect.runPromiseExit(runFull(run, ops, freshPlan, runLoopCheckpoints(db, run)))
      expect(runs.length).toBe(2)
      expect(runs[1]?.resumeSession).toBe("/sessions/first.jsonl")
      expect(runs[1]?.prompt).toContain("the captain answered: Continue, run one test file at a time")
      expect(await Effect.runPromise(openQuestionsForRun(db, run.runId))).toEqual([])
    })
  }, 20_000)

  test("ends the run as stopped on a stop answer, instead of running Pi again", async () => {
    await withLoopRun(30, async (db, run) => {
      let calls = 0
      const ops = fakeOps({
        runAgent: async () => {
          calls += 1
          void answerOnceAsked(run.runDir, "stop")
          return { end: looping, commits: [] }
        },
        execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      }, run.hostSessionsDir)
      const exit = await Effect.runPromiseExit(runFull(run, ops, freshPlan, runLoopCheckpoints(db, run)))
      expect(calls).toBe(1)
      expect(exit).toMatchObject({ _tag: "Failure" })
      expect(JSON.stringify(exit)).toContain("RunStopped")
    })
  }, 20_000)

  test("a parked run answered stop ends before Pi runs, instead of resuming the loop", async () => {
    await withLoopRun(0, async (db, run) => {
      let calls = 0
      const ops = fakeOps({
        runAgent: async () => {
          calls += 1
          return { commits: [] }
        },
        execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      }, run.hostSessionsDir)
      const plan = { ...freshPlan, implementSessionFile: "/sessions/first.jsonl", answers: [{ question: "looping", answer: "stop" }] }
      const exit = await Effect.runPromiseExit(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
      expect(calls).toBe(0)
      expect(JSON.stringify(exit)).toContain("RunStopped")
    })
  })
})

const resumeAfterSpentFixes = async (db: Database, home: string, release: string): Promise<HistoryRun> => {
  const project = join(home, "project")
  const priorDir = join(home, "runs", "prior-a")
  await mkdir(project, { recursive: true })
  await mkdir(priorDir, { recursive: true })
  const priorFix = join(priorDir, "2026-10-19T09-30-00-000Z_bbb222.jsonl")
  await writeFile(priorFix, JSON.stringify({ type: "session", id: "bbb222" }) + "\n")
  await Effect.runPromise(recordRun(db, {
    id: "prior-a", project, branch: "orc/test", taskFile: join(priorDir, "task.md"),
    status: "failed", started: "2026-10-19T09:00:00.000Z"
  }))
  await Effect.runPromise(recordStep(db, {
    runId: "prior-a", name: "implement", attempt: 1, status: "passed",
    started: "2026-10-19T09:00:00.000Z", agentFile: implementer.path, piSessionFile: null
  }))
  await Effect.runPromise(recordStep(db, {
    runId: "prior-a", name: "checks", attempt: 4, status: "failed",
    started: "2026-10-19T09:40:00.000Z", agentFile: null, piSessionFile: null
  }))
  for (const attempt of [1, 2, 3]) {
    await Effect.runPromise(recordFixDone(db, "prior-a", {
      attempt, status: "failed", started: "2026-10-19T09:22:00.000Z", ended: "2026-10-19T09:23:00.000Z",
      agentFile: fixer.path, sessionFile: priorFix, model: fixer.model, thinking: fixer.thinking,
      evidenceIn: join(priorDir, "checks-1.md"), commits: 0, tokens: null
    }))
  }
  const git = await stubGit(home)
  const base = await Effect.runPromise(historyFor("released-b", home, project, "2026-10-19T10:00:00.000Z", git, ""))
  await writeFile(join(project, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
  return { ...base, answers: [{ question: release, answer: "Fix the lint failure first" }] }
}

describe("a hold release reaches the resumed worker", () => {
  test("a resume after a release that an earlier resume already got keeps the spent fixes and the fixer session instead of a second fresh budget", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const plan = await Effect.runPromise(buildResumePlan(db, await resumeAfterSpentFixes(db, home, carriedHoldReleaseId)))
        expect(plan.inheritedFixes).toHaveLength(3)
        expect(plan.fixSessionId).toBe("bbb222")
      } finally {
        db.close()
      }
    })
  })

  test("a released resume with three spent fixes does not end before a fresh fixer sees the release", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const run = await resumeAfterSpentFixes(db, home, holdReleaseId)
        await mkdir(run.piSessionDir, { recursive: true })
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        await Effect.runPromise(recordResumePublish(db, run, plan))
        const delivered: Array<AgentRun> = []
        const ops = fakeOps({
          runAgent: async (agentRun) => {
            delivered.push(agentRun)
            return { commits: [] }
          },
          execCheck: async () => ({ stdout: "lint broken", stderr: "", exitCode: 1 })
        }, run.hostSessionsDir)
        const report = await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
        expect(delivered.length).toBeGreaterThan(0)
        expect(delivered[0]?.resumeSession).toBeNull()
        expect(delivered[0]?.prompt).toContain("Fix the lint failure first")
        expect(delivered.every((agentRun) => agentRun.agent.path === fixer.path)).toBe(true)
        expect(report.implementPassed).toBe(true)
        expect(report.fixAttempts).toBe(3)
      } finally {
        db.close()
      }
    })
  })

  test("a resumed implement prompt carries the hold release instead of dropping it", async () => {
    await withLoopRun(0, async (db, run) => {
      const prompts: Array<string> = []
      const ops = fakeOps({
        runAgent: async (agentRun) => {
          prompts.push(agentRun.prompt)
          return { commits: [] }
        },
        execCheck: async () => {
          throw new Error("checks ran before the implement finished")
        }
      }, run.hostSessionsDir)
      const plan = { ...freshPlan, answers: [{ question: holdReleaseId, answer: "Fix the lint failure first" }] }
      const report = await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
      expect(prompts.length).toBe(1)
      expect(prompts[0]).toContain("Do the task.")
      expect(prompts[0]).toContain("Fix the lint failure first")
      expect(report.implementPassed).toBe(false)
    })
  })

  test("a resumed worker continuation carries the hold release beside the worker answer", async () => {
    await withLoopRun(0, async (db, run) => {
      const prompts: Array<string> = []
      const ops = fakeOps({
        runAgent: async (agentRun) => {
          prompts.push(agentRun.prompt)
          return { commits: [] }
        },
        execCheck: async () => {
          throw new Error("checks ran before the implement finished")
        }
      }, run.hostSessionsDir)
      const plan = {
        ...freshPlan,
        implementSessionFile: "/sessions/first.jsonl",
        answers: [{ question: "ask-1", answer: "Use the cache" }, { question: holdReleaseId, answer: "Fix the lint failure first" }]
      }
      await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
      expect(prompts.length).toBe(1)
      expect(prompts[0]).toContain("Use the cache")
      expect(prompts[0]).toContain("Fix the lint failure first")
    })
  })

  test("every fresh fix attempt carries the hold release instead of starting bare", async () => {
    await withLoopRun(0, async (db, run) => {
      await mkdir(run.piSessionDir, { recursive: true })
      await writeFile(join(run.worktreeDir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
      const prompts: Array<string> = []
      const ops = fakeOps({
        runAgent: async (agentRun) => {
          prompts.push(agentRun.prompt)
          return { commits: [] }
        },
        execCheck: async () => ({ stdout: "lint broken", stderr: "", exitCode: 1 })
      }, run.hostSessionsDir)
      const plan = {
        ...freshPlan,
        skipImplement: true,
        implementSessionId: "aaa111",
        implementSessionFile: "/sessions/first.jsonl",
        answers: [{ question: holdReleaseId, answer: "Fix the lint failure first" }]
      }
      const report = await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
      expect(prompts.length).toBeGreaterThan(1)
      expect(prompts.every((prompt) => prompt.includes("Fix the lint failure first"))).toBe(true)
      expect(report.fixAttempts).toBe(3)
    })
  })

  test("a fresh fix attempt gets only the hold release, not loop or worker answers to a pause and a question it never had", async () => {
    await withLoopRun(0, async (db, run) => {
      await mkdir(run.piSessionDir, { recursive: true })
      await writeFile(join(run.worktreeDir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
      const prompts: Array<string> = []
      const ops = fakeOps({
        runAgent: async (agentRun) => {
          prompts.push(agentRun.prompt)
          return { commits: [] }
        },
        execCheck: async () => ({ stdout: "lint broken", stderr: "", exitCode: 1 })
      }, run.hostSessionsDir)
      const plan = {
        ...freshPlan,
        skipImplement: true,
        implementSessionId: "aaa111",
        implementSessionFile: "/sessions/first.jsonl",
        answers: [
          { question: "looping", answer: "continue with the new plan" },
          { question: "ask-1", answer: "Use the cache" },
          { question: holdReleaseId, answer: "Fix the lint failure first" }
        ]
      }
      await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
      expect(prompts.length).toBeGreaterThan(1)
      expect(prompts.every((prompt) => prompt.includes("Fix the lint failure first"))).toBe(true)
      expect(prompts.some((prompt) => prompt.includes("orc paused you"))).toBe(false)
      expect(prompts.some((prompt) => prompt.includes("The captain answered your question"))).toBe(false)
    })
  })

  test("a looping-continuation retry carries the hold release beside the loop guidance, stating the loop answer once instead of twice", async () => {
    await withLoopRun(0, async (db, run) => {
      await mkdir(run.piSessionDir, { recursive: true })
      await writeFile(join(run.worktreeDir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
      const prompts: Array<string> = []
      const ops = fakeOps({
        runAgent: async (agentRun) => {
          prompts.push(agentRun.prompt)
          return { commits: [] }
        },
        execCheck: async () => ({ stdout: "lint broken", stderr: "", exitCode: 1 })
      }, run.hostSessionsDir)
      const plan = {
        ...freshPlan,
        skipImplement: true,
        implementSessionId: "aaa111",
        implementSessionFile: "/sessions/first.jsonl",
        fixSessionId: "bbb222",
        fixSessionFile: "/sessions/second.jsonl",
        inheritedFixes: [{
          attempt: 1,
          status: "failed" as const,
          started: "2026-10-19T09:22:00.000Z",
          ended: "2026-10-19T09:23:00.000Z",
          agentFile: fixer.path,
          sessionFile: null,
          model: fixer.model,
          thinking: fixer.thinking,
          evidenceIn: "checks-1.md",
          commits: 0,
          tokens: { input: 0, output: 0 }
        }],
        answers: [{ question: "looping", answer: "continue with the new plan" }, { question: holdReleaseId, answer: "Fix the lint failure first" }]
      }
      await Effect.runPromise(runFull(run, ops, plan, runLoopCheckpoints(db, run)))
      expect(prompts.length).toBeGreaterThan(0)
      expect(prompts[0]).toContain("Fix the lint failure first")
      expect(prompts[0]?.split("continue with the new plan")).toHaveLength(2)
    })
  })
})

describe("runFull has no checkpoint-free mode", () => {
  test("omitted checkpoints fail before agent or check work runs", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const project = join(home, "project")
        await mkdir(project, { recursive: true })
        const git = await stubGit(home)
        const run = await Effect.runPromise(historyFor("next-x", home, project, "2026-10-19T10:00:00.000Z", git, ""))
        const plan = { implementSessionId: null, implementSessionFile: null, inheritedImplement: null, skipImplement: false, skipChecks: false, allow: [], answers: [], inheritedRounds: [], inheritedFixes: [], fixSessionId: null, fixSessionFile: null, fixRunning: false, handover: null, priorDir: null, cleanupPriorDir: null }
        let agentCalls = 0
        let checkCalls = 0
        const ops = fakeOps({
          runAgent: async () => {
            agentCalls += 1
            throw new Error("checkpoint-free agent work")
          },
          execCheck: async () => {
            checkCalls += 1
            return { stdout: "", stderr: "", exitCode: 0 }
          }
        }, run.hostSessionsDir)
        const exit = await Effect.runPromiseExit(Reflect.apply(runFull, null, [run, ops, plan]))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(agentCalls).toBe(0)
        expect(checkCalls).toBe(0)
        let checkpointedAgentCalls = 0
        const failingOps = fakeOps({
          runAgent: async () => {
            checkpointedAgentCalls += 1
            throw new Error("checkpointed agent work")
          },
          execCheck: async () => ({ stdout: "", stderr: "", exitCode: 0 })
        }, run.hostSessionsDir)
        const checkpoints = runLoopCheckpoints(db, run)
        const checkpointedExit = await Effect.runPromiseExit(runFull(run, failingOps, plan, checkpoints))
        expect(Exit.isFailure(checkpointedExit)).toBe(true)
        expect(checkpointedAgentCalls).toBe(1)
        const steps = await Effect.runPromise(stepsForRun(db, "next-x"))
        expect(steps.some((step) => step.name === "implement")).toBe(true)
      } finally {
        db.close()
      }
    })
  })
})
