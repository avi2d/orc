import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { answerTask, parkStartedTask, type ExpectedDecision } from "../../../packages/run/src/entities/parked-runs/index"
import { holdTask } from "../../../packages/run/src/features/backlog-planning/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-expected-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Pick the API", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Pick the API\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const at = "2026-11-02T12:00:00.000Z"

type Decision = { readonly ok: true } | { readonly ok: false; readonly message: string }

const decide = async (root: string, id: string, words: string, expected?: ExpectedDecision): Promise<Decision> => {
  try {
    await run(answerTask(root, id, words, at, expected))
    return { ok: true }
  } catch (error) {
    if (typeof error === "object" && error !== null && "detail" in error) {
      return { ok: false, message: String(error.detail) }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

describe("a guarded board answer", () => {
  test("a held answer for a parked decision is refused instead of answering the parked question", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at, log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "question-1", text: "Keep the old flag?" }], at))
      const refused = await decide(root, "orc-1", "question-1=stale", { kind: "held", generation: 0 })
      expect(refused.ok).toBe(false)
      if (!refused.ok) {
        expect(refused.message).toContain("moved while orc read it")
      }
    })
  })

  test("a parked answer for a held decision is refused instead of answering the hold", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(holdTask(root, record.spec.id, { reason: "Pick one", until: null, questions: ["REST or gRPC?"] }))
      const refused = await decide(root, "orc-1", "question-1=stale", { kind: "parked" })
      expect(refused.ok).toBe(false)
      if (!refused.ok) {
        expect(refused.message).toContain("moved while orc read it")
      }
    })
  })

  test("a held answer for a later hold generation is refused instead of releasing the new hold", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(holdTask(root, record.spec.id, { reason: "Pick one", until: null, questions: ["REST or gRPC?"] }))
      const refused = await decide(root, "orc-1", "question-1=gRPC", { kind: "held", generation: 1 })
      expect(refused.ok).toBe(false)
      if (!refused.ok) {
        expect(refused.message).toContain("was reheld while orc read it")
      }
    })
  })

  test("a held answer for its own generation answers the hold", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(holdTask(root, record.spec.id, { reason: "Pick one", until: null, questions: ["REST or gRPC?"] }))
      const answered = await decide(root, "orc-1", "question-1=gRPC", { kind: "held", generation: 0 })
      expect(answered).toEqual({ ok: true })
    })
  })

  test("a parked answer for a parked decision answers the parked question", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at, log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "question-1", text: "Keep the old flag?" }], at))
      const answered = await decide(root, "orc-1", "question-1=Keep it", { kind: "parked" })
      expect(answered).toEqual({ ok: true })
    })
  })

  test("an unguarded answer still answers a held question", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(holdTask(root, record.spec.id, { reason: "Pick one", until: null, questions: ["REST or gRPC?"] }))
      const answered = await decide(root, "orc-1", "question-1=gRPC")
      expect(answered).toEqual({ ok: true })
    })
  })

  test("an unguarded answer still answers a parked question", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at, log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "question-1", text: "Keep the old flag?" }], at))
      const answered = await decide(root, "orc-1", "question-1=Keep it")
      expect(answered).toEqual({ ok: true })
    })
  })
})
