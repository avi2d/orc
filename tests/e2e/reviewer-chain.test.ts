import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { openDatabase, recordRun, recordSignal, recordStep, type StepInput } from "../../packages/run/src/entities/run-history/index"
import { chainReviewer } from "../../packages/run/src/features/running-a-task/run-deliverer"
import type { ReviewerPick } from "../../packages/run/src/features/running-a-task/run-ops"
import type { ProviderRoom } from "../../packages/run/src/shared/config/index"
import { chainEntry, cleanFinish, git, readyToCheck, recordingKinds, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withPushedBase, withRepo } from "./run-helpers"

const withReadyBranch = (use: (ready: { readonly dir: string; readonly home: string; readonly sha: string; readonly kinds: Array<string>; readonly worktreeDir: string }) => Promise<void>): Promise<void> =>
  withRepo((dir) =>
    withHome((home) =>
      withPushedBase(dir, async (origin) => {
        const sha = await readyToCheck(dir, home)
        const worktreeDir = join(home, "worktree")
        const baseBranch = git(dir, ["branch", "--show-current"])
        git(dir, ["clone", "-q", "--shared", "-b", "orc/test", dir, worktreeDir])
        git(worktreeDir, ["config", "user.name", "orc test"])
        git(worktreeDir, ["config", "user.email", "orc@test.invalid"])
        git(worktreeDir, ["remote", "set-url", "origin", origin])
        git(worktreeDir, ["remote", "set-head", "origin", baseBranch])
        await writeFile(join(worktreeDir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\n")
        await use({ dir, home, sha, kinds: [], worktreeDir })
      })
    )
  )

const lintPasses = async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 })
const room = { kind: "room" } as const
const exhausted = { kind: "no-room", reason: "2% left, floor 10%" } as const
const chain = [chainEntry("beta/reviewer"), chainEntry("gamma/reviewer")] as const
const sameProviderFirst = [chainEntry("acme/coder"), ...chain] as const

const pickWith = (rooms: Readonly<Record<string, ProviderRoom>>, entries: typeof chain | typeof sameProviderFirst = chain): ReviewerPick =>
  (runAgent, eligibility) =>
    chainReviewer({
      chain: entries,
      readRoom: Effect.succeed(({ provider }) => rooms[provider] ?? { kind: "no-room", reason: "no reading" }),
      openReviewer: () => Effect.succeed(runAgent)
    })(runAgent, eligibility)

const passReview = async (sessionsDir: string) => {
  const sessionFile = join(sessionsDir, "review.jsonl")
  await writeFile(sessionFile, sessionEnding({ ...cleanFinish, content: [{ type: "text", text: "[]" }] }))
  return { sessionFile, commits: [] }
}

const cleanReviewer = (sha: string, model: string, kinds: Array<string>) =>
  recordingKinds(async (run, sessionsDir) => {
    if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
    expect(run.agent.model).toBe(model)
    return passReview(sessionsDir)
  }, kinds)

const errorFinding = [{ id: "missing-file", file: "fix.txt", line: null, severity: "error", action: "Add the file.", description: "The file is missing." }]

const replyFindings = async (sessionsDir: string, name: string, findings: ReadonlyArray<unknown>) => {
  const sessionFile = join(sessionsDir, name + ".jsonl")
  await writeFile(sessionFile, sessionEnding({ ...cleanFinish, content: [{ type: "text", text: JSON.stringify(findings) }] }))
  return { sessionFile, commits: [] }
}

const commitFix = async (worktreeDir: string, sessionsDir: string, name: string) => {
  await writeFile(join(worktreeDir, name + ".txt"), name)
  git(worktreeDir, ["add", name + ".txt"])
  git(worktreeDir, ["commit", "-qm", "Fix " + name])
  const sessionFile = join(sessionsDir, name + ".jsonl")
  await writeFile(sessionFile, sessionEnding(cleanFinish))
  return { sessionFile, commits: [{ sha: git(worktreeDir, ["rev-parse", "HEAD"]) }] }
}

type SeededStep = Pick<StepInput, "name" | "status" | "model"> & { readonly commits?: number }

const seedCrashedRun = (home: string, project: string, steps: ReadonlyArray<SeededStep>): Promise<void> =>
  Effect.runPromise(Effect.acquireUseRelease(openDatabase(home), (db) =>
    Effect.gen(function*() {
      yield* recordRun(db, { id: "step-run-1", project, branch: "orc/test", taskFile: join(home, "runs", "step-run-1", "task.md"), status: "running", started: "2026-10-19T09:00:00.000Z", delivery: "orc" })
      for (const { commits, ...step } of steps) {
        const stepId = yield* recordStep(db, { runId: "step-run-1", attempt: 1, started: "2026-10-19T09:00:00.000Z", agentFile: "bundled/" + step.name + ".md", thinking: "high", ...step })
        if (commits !== undefined) {
          yield* recordSignal(db, { stepId, name: "commit-count", value: commits.toString() })
        }
      }
    }), (db) => Effect.sync(() => db.close())).pipe(Effect.provide(BunServices.layer)))

const commitSendBack = async (worktreeDir: string, sessionsDir: string) => {
  await writeFile(join(worktreeDir, "send-back.txt"), "applied")
  git(worktreeDir, ["add", "send-back.txt"])
  git(worktreeDir, ["commit", "-qm", "Apply the send-back"])
  const sessionFile = join(sessionsDir, "implement.jsonl")
  await writeFile(sessionFile, sessionEnding(cleanFinish))
  return { sessionFile, commits: [{ sha: git(worktreeDir, ["rev-parse", "HEAD"]) }] }
}

describe("an orc run's review turn takes the first chain reviewer with room on another provider", () => {
  test("uses the second reviewer instead of stopping when the first has no quota room", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const outcome = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "gamma/reviewer", kinds), lintPasses, pickWith({ beta: exhausted, gamma: room }), { worktreeDir })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(outcome.steps).toContainEqual({ name: "review", status: "passed" })
      expect(outcome.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
      expect(outcome.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("skips the implementer's provider with room instead of giving it the first review turn", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const outcome = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), lintPasses, pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst), { worktreeDir })
      expect(outcome.stepAgents).toContainEqual({ name: "review", model: "beta/reviewer", thinking: "high" })
      expect(outcome.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("parks without a PR and lets the only eligible provider review after dispatch assigns it the resumed run", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
        pickWith({ acme: room, beta: exhausted, gamma: exhausted }, sameProviderFirst), { worktreeDir })
      expect(kinds).toEqual(["implementer"])
      expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
      expect(outcome.stepAgents).toContainEqual({ name: "review", model: null, thinking: null })
      expect(JSON.stringify(outcome.runSignals)).toContain("review-failure")
      expect(outcome.report.endReason).toContain("no reviewer in the chain has quota room")
      expect(outcome.report.prLink).toBeNull()
      expect(outcome.ghCalls).not.toContain("pr create")

      const resumed = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), lintPasses,
        pickWith({ acme: room, beta: room, gamma: exhausted }, sameProviderFirst),
        { worktreeDir, resumeRun: outcome.report.runId, implementerModel: "beta/coder", fixerModel: "beta/coder" })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(resumed.stepAgents).toContainEqual({ name: "review", model: "beta/reviewer", thinking: "high" })
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("does not let the resumed provider review its own fix and saves both writers when it parks again", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const parked = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
        pickWith({ acme: room, beta: exhausted, gamma: exhausted }, sameProviderFirst), { worktreeDir })

      const reviewThenFix = recordingKinds(async (run, sessionsDir) => {
        const sessionFile = join(sessionsDir, run.agent.kind + ".jsonl")
        if (run.agent.kind === "reviewer") {
          expect(run.agent.model).toBe("beta/reviewer")
          const findings = [{ id: "missing-file", file: "fix.txt", line: null, severity: "error", action: "Add the file.", description: "The file is missing." }]
          await writeFile(sessionFile, sessionEnding({ ...cleanFinish, content: [{ type: "text", text: JSON.stringify(findings) }] }))
          return { sessionFile, commits: [] }
        }
        expect(run.agent.model).toBe("beta/coder")
        await writeFile(join(worktreeDir, "fix.txt"), "fixed")
        git(worktreeDir, ["add", "fix.txt"])
        git(worktreeDir, ["commit", "-qm", "Add the missing file"])
        await writeFile(sessionFile, sessionEnding(cleanFinish))
        return { sessionFile, commits: [{ sha: git(worktreeDir, ["rev-parse", "HEAD"]) }] }
      }, kinds)

      const resumed = await runOrcDeliveryStep(dir, home, reviewThenFix, lintPasses,
        pickWith({ acme: room, beta: room, gamma: exhausted }, sameProviderFirst),
        { worktreeDir, resumeRun: parked.report.runId, implementerModel: "beta/coder", fixerModel: "beta/coder" })
      expect(kinds).toEqual(["implementer", "reviewer", "fixer"])
      expect(resumed.ghCalls).not.toContain("pr create")
      const wait: unknown = await Bun.file(join(home, "runs", resumed.report.runId, "reviewer-wait.json")).json()
      expect(wait).toMatchObject({ implementerProviders: ["acme", "beta"] })
    })
  })

  test("reruns the checks and lets the recovered provider review instead of applying a parked send-back again", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const checksThenPass = async () => {
        kinds.push("checks")
        return lintPasses()
      }
      const opened = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), checksThenPass,
        pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst), { worktreeDir })
      const sentBack = [{ question: "send-back", answer: "rename the flag", decider: "owner" as const }]
      const parked = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), checksThenPass,
        pickWith({ acme: room, beta: exhausted, gamma: exhausted }, sameProviderFirst),
        { worktreeDir, resumeRun: opened.report.runId, answers: sentBack })
      expect(parked.report.endReason).toContain("no reviewer in the chain has quota room")
      kinds.length = 0

      const resumed = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), checksThenPass,
        pickWith({ acme: room, beta: room, gamma: exhausted }, sameProviderFirst),
        { worktreeDir, resumeRun: parked.report.runId, runId: "step-run-3", answers: sentBack, implementerModel: "beta/coder", fixerModel: "beta/coder" })
      expect(kinds).toEqual(["checks", "reviewer", "reviewer"])
      expect(resumed.stepAgents).toContainEqual({ name: "review", model: "beta/reviewer", thinking: "high" })
      expect(resumed.steps).toContainEqual({ name: "review", status: "passed" })
    })
  })

  test("applies only the new send-back instead of dropping it with the one already applied", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const opened = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), lintPasses,
        pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst), { worktreeDir })
      const applied = { question: "send-back", answer: "rename the first flag", decider: "owner" as const }
      const added = { question: "send-back-2", answer: "remove the old example", decider: "owner" as const }
      const parked = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
        pickWith({ acme: room, beta: exhausted, gamma: exhausted }, sameProviderFirst),
        { worktreeDir, resumeRun: opened.report.runId, answers: [applied] })
      expect(parked.report.waitingForReviewer).toBe(true)
      kinds.length = 0

      const applyNew = recordingKinds(async (run, sessionsDir) => {
        if (run.agent.kind === "reviewer") {
          expect(run.agent.model).toBe("gamma/reviewer")
          return passReview(sessionsDir)
        }
        expect(run.prompt).not.toContain(applied.answer)
        expect(run.prompt).toContain(added.answer)
        return commitSendBack(worktreeDir, sessionsDir)
      }, kinds)
      const resumed = await runOrcDeliveryStep(dir, home, applyNew, lintPasses,
        pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst),
        { worktreeDir, resumeRun: parked.report.runId, runId: "step-run-3", answers: [applied, added], implementerModel: "beta/coder" })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("an ordinary send-back excludes earlier writers instead of asking acme to review its own work", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const pick = pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst)
      const opened = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), lintPasses, pick, { worktreeDir })
      const sendBack = { question: "send-back", answer: "remove the old example", decider: "owner" as const }
      kinds.length = 0

      const applySendBack = recordingKinds(async (run, sessionsDir) => {
        if (run.agent.kind === "reviewer") {
          expect(run.agent.model).toBe("gamma/reviewer")
          return passReview(sessionsDir)
        }
        expect(run.agent.model).toBe("beta/coder")
        expect(run.prompt).toContain(sendBack.answer)
        return commitSendBack(worktreeDir, sessionsDir)
      }, kinds)
      const resumed = await runOrcDeliveryStep(dir, home, applySendBack, lintPasses, pick,
        { worktreeDir, resumeRun: opened.report.runId, answers: [sendBack], implementerModel: "beta/coder" })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(resumed.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })
})

describe("a provider that ran an interrupted step on the branch never reviews it", () => {
  test("an implementation interrupted before it recorded its commits keeps acme out of the review after beta resumes it", async () => {
    await withReadyBranch(async ({ dir, home, kinds, worktreeDir }) => {
      await seedCrashedRun(home, dir, [{ name: "implement", status: "running", model: "acme/coder" }])
      const resumeWithoutNewCommits = recordingKinds(async (run, sessionsDir) => {
        if (run.agent.kind === "reviewer") {
          expect(run.agent.model).toBe("gamma/reviewer")
          return passReview(sessionsDir)
        }
        expect(run.agent.model).toBe("beta/coder")
        const sessionFile = join(sessionsDir, "implement.jsonl")
        await writeFile(sessionFile, sessionEnding(cleanFinish))
        return { sessionFile, commits: [] }
      }, kinds)
      const resumed = await runOrcDeliveryStep(dir, home, resumeWithoutNewCommits, lintPasses,
        pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst),
        { worktreeDir, resumeRun: "step-run-1", implementerModel: "beta/coder", fixerModel: "beta/coder" })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(resumed.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("a fix interrupted before it recorded its commits keeps beta out of the review after gamma resumes the run", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      await writeFile(join(worktreeDir, "interrupted-fix.txt"), "fixed by beta")
      git(worktreeDir, ["add", "interrupted-fix.txt"])
      git(worktreeDir, ["commit", "-qm", "Fix the failing check"])
      await seedCrashedRun(home, dir, [
        { name: "implement", status: "passed", model: "acme/coder", commits: 1 },
        { name: "checks", status: "failed", model: null },
        { name: "fix", status: "running", model: "beta/coder" }
      ])
      const resumed = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "gamma/reviewer", kinds), lintPasses,
        pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst),
        { worktreeDir, resumeRun: "step-run-1", implementerModel: "gamma/coder", fixerModel: "gamma/coder" })
      expect(kinds).toEqual(["reviewer", "reviewer"])
      expect(resumed.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })
})

describe("a new send-back on a reviewer quota resume starts a fresh review cycle", () => {
  test("gives the new send-back's findings a fix round instead of inheriting the two rounds the parked run spent", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds, worktreeDir }) => {
      const rooms: Record<string, ProviderRoom> = { acme: room, beta: room, gamma: exhausted }
      const pick = pickWith(rooms, sameProviderFirst)
      const opened = await runOrcDeliveryStep(dir, home, cleanReviewer(sha, "beta/reviewer", kinds), lintPasses, pick, { worktreeDir })
      const first = { question: "send-back", answer: "rename the first flag", decider: "owner" as const }
      const second = { question: "send-back-2", answer: "remove the old example", decider: "owner" as const }

      let fixesInParkedRun = 0
      const spendBothRounds = recordingKinds(async (run, sessionsDir) => {
        if (run.agent.kind === "reviewer") return replyFindings(sessionsDir, "review-" + kinds.length.toString(), errorFinding)
        if (run.agent.kind === "implementer") return commitSendBack(worktreeDir, sessionsDir)
        fixesInParkedRun += 1
        if (fixesInParkedRun === 2) rooms.beta = exhausted
        return commitFix(worktreeDir, sessionsDir, "parked-fix-" + fixesInParkedRun.toString())
      }, kinds)
      kinds.length = 0
      const parked = await runOrcDeliveryStep(dir, home, spendBothRounds, lintPasses, pick,
        { worktreeDir, resumeRun: opened.report.runId, answers: [first] })
      expect(kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer"])
      expect(parked.report.waitingForReviewer).toBe(true)
      const wait: unknown = await Bun.file(join(home, "runs", parked.report.runId, "reviewer-wait.json")).json()
      expect(wait).toMatchObject({ sentPerRound: [errorFinding, errorFinding] })

      rooms.beta = room
      let reviewsInResumedRun = 0
      const fixNewFindings = recordingKinds(async (run, sessionsDir) => {
        if (run.agent.kind === "reviewer") {
          reviewsInResumedRun += 1
          return replyFindings(sessionsDir, "resumed-review-" + reviewsInResumedRun.toString(), reviewsInResumedRun === 1 ? errorFinding : [])
        }
        if (run.agent.kind === "implementer") {
          expect(run.prompt).toContain(second.answer)
          return commitFix(worktreeDir, sessionsDir, "send-back-2")
        }
        return commitFix(worktreeDir, sessionsDir, "resumed-fix")
      }, kinds)
      kinds.length = 0
      const resumed = await runOrcDeliveryStep(dir, home, fixNewFindings, lintPasses, pick,
        { worktreeDir, resumeRun: parked.report.runId, runId: "step-run-3", answers: [first, second] })
      expect(kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "reviewer"])
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })
})
