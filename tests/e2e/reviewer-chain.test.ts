import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
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

const cleanReviewer = (sha: string, model: string, kinds: Array<string>) =>
  recordingKinds(async (run, sessionsDir) => {
    if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
    expect(run.agent.model).toBe(model)
    const sessionFile = join(sessionsDir, "review.jsonl")
    await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: "[]" }], stopReason: "stop", usage: { input: 1, output: 1 } }))
    return { sessionFile, commits: [] }
  }, kinds)

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
          const sessionFile = join(sessionsDir, "review.jsonl")
          await writeFile(sessionFile, sessionEnding({ ...cleanFinish, content: [{ type: "text", text: "[]" }] }))
          return { sessionFile, commits: [] }
        }
        expect(run.prompt).not.toContain(applied.answer)
        expect(run.prompt).toContain(added.answer)
        const sessionFile = join(sessionsDir, "implement.jsonl")
        await writeFile(sessionFile, sessionEnding(cleanFinish))
        git(worktreeDir, ["commit", "--allow-empty", "-qm", "Apply the second send-back"])
        return { sessionFile, commits: [{ sha: git(worktreeDir, ["rev-parse", "HEAD"]) }] }
      }, kinds)
      const resumed = await runOrcDeliveryStep(dir, home, applyNew, lintPasses,
        pickWith({ acme: room, beta: room, gamma: room }, sameProviderFirst),
        { worktreeDir, resumeRun: parked.report.runId, runId: "step-run-3", answers: [applied, added], implementerModel: "beta/coder" })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })
})
