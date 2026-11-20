import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { askSetupFor } from "../../packages/run/src/entities/agent/index"
import type { OpenQuestion } from "../../packages/run/src/entities/review-gate/index"
import { endingFromResult, type RunnerResult } from "../../packages/run/src/features/queueing-a-task/index"
import { recordOpenAsks } from "../../packages/run/src/features/running-a-task/history-write"
import { addTask, findTask, writeTaken } from "../../packages/run/src/entities/backlog/index"
import { answerTask, handAnswersToResume, parkStartedTask } from "../../packages/run/src/entities/parked-runs/index"
import { waitingParkOf } from "../../packages/run/src/widgets/beat/beat-close"

const answered: OpenQuestion = { id: "report-tail-misses-failures", text: "Which report tail do you want?", asked: "2026-11-16T16:32:05.702Z" }
const unanswered: OpenQuestion = { id: "loose-command-end-marker", text: "Drop the second clause?", asked: "2026-11-16T16:32:05.702Z" }
const gateStop = "Pi made 2 commits on orc/orc-67, and the checks passed. no-mistakes stopped at the review gate. finding review-1 needs an answer orc cannot give. No PR opens."

const recordedBy = (priorOpen: ReadonlyArray<OpenQuestion>): ReadonlyArray<OpenQuestion> => {
  const recorded: Array<OpenQuestion> = []
  const setup = askSetupFor("/r", "/r/session", 0, [{ question: answered.id, answer: "B" }], priorOpen)
  Effect.runSync(recordOpenAsks((_step, question) => Effect.sync(() => {
    recorded.push(question)
  }), setup, { name: "implement", attempt: 1 }, []))
  return recorded
}

const finishedRun = (openQuestions: ReadonlyArray<OpenQuestion>): RunnerResult => ({
  task: "orc-67",
  pueueTask: 7,
  status: "failed",
  started: "2026-11-18T10:00:00.000Z",
  ended: "2026-11-18T10:00:05.000Z",
  reason: "orc exited 1",
  run: { id: "20261118-100000-abcdef", status: "failed", prLink: null, endReason: gateStop, openQuestions }
})

describe("a resumed run that stops at an unchanged gate", () => {
  test("keeps the task parked on its gate instead of closing it failed, reporting the gate once", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-parked-"))
    try {
      const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
        Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))
      const created = await run(addTask(root, {
        title: "Own review", project: "orc", kind: "ship", internal: false, machine: null,
        parent: null, split: null, dependsOn: [], priority: 0,
        created: "2026-11-18T10:00:00.000Z", body: "Do it.\n"
      }))
      const id = created.spec.id
      const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-18T10:00:00.000Z" }
      const started = { at: "2026-11-18T10:00:00.000Z", log: "log" }
      await run(writeTaken(root, { ...created, state: { kind: "started", claim, started } }))
      const gate: OpenQuestion = { id: "review-1", text: "Drop the second clause?", asked: "2026-11-18T10:00:00.000Z", blocks: true }
      await run(parkStartedTask(root, id, "orc/test", [gate], "2026-11-18T10:01:00.000Z", "run-1"))
      await run(answerTask(root, id, "review-1=Keep it", "2026-11-18T10:02:00.000Z"))
      const resumed = handAnswersToResume(await run(findTask(root, id)))
      await run(writeTaken(root, { ...resumed, state: { kind: "started", claim, started } }))
      const waiting = waitingParkOf(await run(findTask(root, id)), { kind: "close", outcome: "failed", reason: gateStop, pr: null, report: null })
      expect(waiting).not.toBeNull()
      if (waiting === null) {
        throw new Error("the failed resumed run keeps its parked gate")
      }
      await run(parkStartedTask(root, id, "orc/test", waiting, "2026-11-18T10:04:00.000Z"))
      const kept = await run(findTask(root, id))
      expect(kept.state.kind).toBe("new")
      expect(kept.parked?.branch).toBe("orc/test")
      expect(kept.parked?.origin).toMatchObject({ run: "run-1" })
      expect(kept.parked?.questions.map((question) => question.id)).toEqual(["review-1"])
      expect(kept.parked?.questions[0]?.answer).not.toBeNull()
      const items = await readdir(join(root, "attention"))
      expect(items.filter((name) => name.includes("review_1"))).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("still parks on a question of the resumed run that no answer settled, rather than dropping it", () => {
    const recorded = recordedBy([answered, unanswered])
    expect(recorded).toEqual([unanswered])
    expect(endingFromResult(finishedRun(recorded), "ship")).toEqual({ kind: "park", questions: [unanswered] })
  })
})
