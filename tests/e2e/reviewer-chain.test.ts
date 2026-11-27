import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { chainReviewer } from "../../packages/run/src/features/running-a-task/run-deliverer"
import type { ReviewerPick } from "../../packages/run/src/features/running-a-task/run-ops"
import type { ProviderRoom } from "../../packages/run/src/shared/config/index"
import { chainEntry, git, readyToCheck, recordingKinds, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withPushedBase, withRepo } from "./run-helpers"

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

const pickWith = (rooms: Readonly<Record<string, ProviderRoom>>): ReviewerPick => (runAgent) =>
  chainReviewer({
    chain,
    implementerProvider: "acme",
    readRoom: Effect.succeed(({ provider }) => rooms[provider] ?? { kind: "no-room", reason: "no reading" }),
    openReviewer: () => Effect.succeed(runAgent)
  })(runAgent)

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
          expect(kinds).toEqual(["implementer", "reviewer"])
          expect(outcome.steps).toContainEqual({ name: "review", status: "passed" })
          expect(outcome.stepAgents).toContainEqual({ name: "review", model: "gamma/reviewer", thinking: "high" })
          expect(outcome.ghCalls).toContain("pr create --head orc/test")
    })
  })

  test("fails the review turn and opens no PR when no entry has room, instead of reviewing anyway", async () => {
    await withReadyBranch(async ({ dir, home, sha, kinds }) => {
          const outcome = await runOrcDeliveryStep(dir, home, recordingKinds(sandboxResult(sha), kinds), lintPasses,
            pickWith({ acme: { kind: "room" }, beta: { kind: "no-room", reason: "beta-main 2% left, floor 10%" }, gamma: { kind: "no-room", reason: "quota unread: timed out" } }))
          expect(kinds).toEqual(["implementer"])
          expect(outcome.steps).toContainEqual({ name: "review", status: "failed" })
          expect(outcome.stepAgents).toContainEqual({ name: "review", model: null, thinking: null })
          expect(JSON.stringify(outcome.runSignals)).toContain("review-failure")
          expect(outcome.report.endReason).toContain("no reviewer in the chain has quota room")
          expect(outcome.report.prLink).toBeNull()
          expect(outcome.ghCalls).not.toContain("pr create")
    })
  })
})
