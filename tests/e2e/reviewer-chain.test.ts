import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { chainReviewer } from "../../packages/run/src/features/running-a-task/run-deliverer"
import type { ReviewerChoice } from "../../packages/run/src/features/running-a-task/run-ops"
import { type ProviderRoom, ReviewerWait } from "../../packages/run/src/shared/config/index"
import { chainEntry, git, readyToCheck, recordingKinds, runOrcDeliveryResume, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withPushedBase, withRepo } from "./run-helpers"

const withReadyBranch = (use: (ready: { readonly dir: string; readonly home: string; readonly sha: string; readonly kinds: Array<string> }) => Promise<void>): Promise<void> =>
  withRepo((dir) =>
    withHome((home) =>
      withPushedBase(dir, async () => {
        const sha = await readyToCheck(dir, home)
        git(dir, ["checkout", "-q", "orc/test"])
        await use({ dir, home, sha, kinds: [] })
      })
    )
  )

const lintPasses = async () => ({ stdout: "lint ok", stderr: "", exitCode: 0 })

const chain = [chainEntry("acme/coder"), chainEntry("beta/reviewer"), chainEntry("gamma/reviewer")] as const

const pickWith = (rooms: Readonly<Record<string, ProviderRoom>>): ReviewerChoice => (implementerModel) => (runAgent) =>
  chainReviewer({
    chain,
    readRoom: Effect.succeed(({ provider }) => rooms[provider] ?? { kind: "no-room", reason: "no reading" }),
    openReviewer: () => Effect.succeed(runAgent)
  })(implementerModel)(runAgent)

describe("an orc run's review turn takes the first chain reviewer with room on another provider", () => {
  test("reviews on the third entry when the second has no room, instead of the implementer's provider", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds }) => {
          const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(async (run, sessionsDir) => {
            if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
            expect(run.agent.model).toBe("gamma/reviewer")
            const sessionFile = join(sessionsDir, "review.jsonl")
            await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: "[]" }], stopReason: "stop", usage: { input: 1, output: 1 } }))
            return { sessionFile, commits: [] }
          }, kinds), lintPasses, pickWith({ acme: { kind: "room" }, beta: { kind: "no-room", reason: "beta-main 2% left, floor 10%" }, gamma: { kind: "room" } }))
          expect(kinds).toEqual(["implementer", "reviewer", "reviewer"])
          expect(outcome.steps).toContainEqual({ name: "review", status: "passed" })
          expect(outcome.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
          expect(outcome.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("parks the run with the no-room reason and opens no PR when no entry has room, instead of reviewing anyway or ending for good", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds }) => {
          const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
            pickWith({ acme: { kind: "room" }, beta: { kind: "no-room", reason: "beta-main 2% left, floor 10%" }, gamma: { kind: "no-room", reason: "quota unread: timed out" } }))
          expect(kinds).toEqual(["implementer"])
          expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
          expect(outcome.stepAgents).toContainEqual({ name: "review", model: null, thinking: null })
          expect(JSON.stringify(outcome.runSignals)).toContain("review-failure")
          expect(outcome.report.endReason).toContain("no reviewer in the chain has quota room")
          expect(outcome.report.endReason).toStartWith("The review turn waits for a reviewer in the chain to have room, so the run parks and no PR opens: ")
          expect(outcome.report.prLink).toBeNull()
          expect(outcome.ghCalls).not.toContain("pr create")
          const wait = Schema.decodeSync(Schema.fromJsonString(ReviewerWait))(await readFile(join(home, "runs", "step-run-1", "reviewer-wait.json"), "utf8"))
          expect(wait.reviewers.map((entry) => entry.model)).toEqual(["beta/reviewer", "gamma/reviewer"])
    })
  })

  test("a parked run resumed once an entry has room reviews on that entry and opens its PR, instead of implementing again", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds }) => {
          await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
            pickWith({ acme: { kind: "room" }, beta: { kind: "no-room", reason: "beta-main 2% left, floor 10%" }, gamma: { kind: "no-room", reason: "gamma-main 0% left, floor 10%" } }))
          const resumedKinds: Array<string> = []
          const resumed = await runOrcDeliveryResume(dir, home, recordingKinds(async (run, sessionsDir) => {
            if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
            expect(run.agent.model).toBe("gamma/reviewer")
            const sessionFile = join(sessionsDir, "review.jsonl")
            await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: "[]" }], stopReason: "stop", usage: { input: 1, output: 1 } }))
            return { sessionFile, commits: [] }
          }, resumedKinds), lintPasses, pickWith({ acme: { kind: "room" }, beta: { kind: "no-room", reason: "beta-main 2% left, floor 10%" }, gamma: { kind: "room" } }))
          expect(resumedKinds).toEqual(["reviewer"])
          expect(resumed.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
          expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  })

  const resumedOnBeta = async (resumeRooms: Readonly<Record<string, ProviderRoom>>): Promise<void> => {
    await withReadyBranch(async ({ dir, home, sha, kinds }) => {
          await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
            pickWith({ acme: { kind: "room" }, beta: { kind: "no-room", reason: "beta-main 2% left, floor 10%" }, gamma: { kind: "no-room", reason: "gamma-main 0% left, floor 10%" } }))
          const resumedKinds: Array<string> = []
          const resumed = await runOrcDeliveryResume(dir, home, recordingKinds(async (run, sessionsDir) => {
            if (run.agent.kind !== "reviewer") return sandboxResult(sha)(run, sessionsDir)
            const sessionFile = join(sessionsDir, "review.jsonl")
            await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: "[]" }], stopReason: "stop", usage: { input: 1, output: 1 } }))
            return { sessionFile, commits: [] }
          }, resumedKinds), lintPasses, pickWith(resumeRooms), "beta/coder")
          expect(resumedKinds).toEqual(["reviewer"])
          expect(resumed.stepAgents).toContainEqual({ name: "review", model: "beta/reviewer", thinking: "high" })
          expect(resumed.ghCalls).toContain("pr create --head orc/test")
    })
  }

  test("a parked run resumed on another provider's account while both have room reviews off the provider that implemented it, instead of on the implementer's provider", async () => {
    await resumedOnBeta({ acme: { kind: "room" }, beta: { kind: "room" }, gamma: { kind: "no-room", reason: "gamma-main 0% left, floor 10%" } })
  })

  test("a parked run resumed on another provider's account after the implementer's provider runs out reviews on the waiting entry, instead of passing it over as the implementer's", async () => {
    await resumedOnBeta({ acme: { kind: "no-room", reason: "acme-main 1% left, floor 10%" }, beta: { kind: "room" }, gamma: { kind: "no-room", reason: "gamma-main 0% left, floor 10%" } })
  })

  test("still fails the review turn when every entry is on the implementer's provider, instead of parking on a wait no quota ends", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds }) => {
          const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses, (implementerModel) => (runAgent) =>
            chainReviewer({ chain: [chainEntry("acme/coder")], readRoom: Effect.succeed(() => ({ kind: "room" })), openReviewer: () => Effect.succeed(runAgent) })(implementerModel)(runAgent))
          expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
          expect(outcome.report.endReason).not.toContain("the run parks")
          expect(outcome.ghCalls).not.toContain("pr create")
    })
  })
})
