import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { chainReviewer } from "../../packages/run/src/features/running-a-task/run-deliverer"
import type { ReviewerPick } from "../../packages/run/src/features/running-a-task/run-ops"
import type { ProviderRoom } from "../../packages/run/src/shared/config/index"
import { chainEntry, git, readyToCheck, recordingKinds, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withPushedBase, withRepo } from "./run-helpers"

const withReadyBranch = (use: (ready: { readonly dir: string; readonly home: string; readonly sha: string; readonly kinds: Array<string>; readonly worktreeDir: string }) => Promise<void>): Promise<void> =>
  withRepo((dir) =>
    withHome((home) =>
      withPushedBase(dir, async (origin) => {
        const sha = await readyToCheck(dir, home)
        const worktreeDir = join(home, "worktree")
        const baseBranch = git(dir, ["branch", "--show-current"])
        git(dir, ["clone", "-q", "--shared", "-b", "orc/test", dir, worktreeDir])
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

const pickWith = (rooms: Readonly<Record<string, ProviderRoom>>, entries: typeof chain | typeof sameProviderFirst = chain, implementerProvider = "acme"): ReviewerPick =>
  (runAgent, parkedImplementerProvider) =>
    chainReviewer({
      chain: entries,
      implementerProvider,
      readRoom: Effect.succeed(({ provider }) => rooms[provider] ?? { kind: "no-room", reason: "no reading" }),
      openReviewer: () => Effect.succeed(runAgent)
    })(runAgent, parkedImplementerProvider)

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

  test("opens no unreviewed PR during quota exhaustion and resumes review with the original implementer's provider excluded", async () => {
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
        pickWith({ acme: room, beta: room, gamma: exhausted }, sameProviderFirst, "gamma"), { worktreeDir, resumeRun: outcome.report.runId })
      expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
      expect(resumed.stepAgents).toContainEqual({ name: "review", model: "beta/reviewer", thinking: "high" })
      expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })
})
