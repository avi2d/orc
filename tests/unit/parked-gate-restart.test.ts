import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Effect } from "effect"
import { driveNoMistakes, type NoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { GateResponse } from "../../packages/run/src/entities/review-gate/no-mistakes-gate"
import { endingFromResult, type RunnerResult } from "../../packages/run/src/features/queueing-a-task/index"
import { addTask, answerWait, findTask, writeTaken } from "../../packages/run/src/entities/backlog/index"
import { answerTask, parkStartedTask } from "../../packages/run/src/entities/parked-runs/index"
import { openItems, openReviewQuestions } from "../../packages/run/src/entities/attention/index"
import type { OpenQuestion } from "../../packages/run/src/entities/review-gate/index"

const refusedGate = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: awaiting_approval",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[2]{id,severity,file,line,action,description}:",
  "    r1,warning,a.go,,auto-fix,ignored error",
  "    review-1,error,b.go,,manual,needs a human",
  "gate: review"
].join("\n")

const failedRun = [
  "run:",
  "  id: \"01M5EH9DXNBCAYWRHSF7VM1480\"",
  "  branch: fm/orc-dash-captain-log",
  "  status: failed",
  "  steps[2]{step,status,findings,duration_ms}:",
  "    test,completed,0,582251",
  "    lint,failed,12,963128",
  "outcome: failed",
  "error: \"step lint failed\""
].join("\n")

const completedRun = [
  "current_branch: orc/test",
  "other_branch_run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: completed",
  "  head: abc1234",
  "  pr: \"https://github.com/o/r/pull/4\"",
  "  findings: 1 awaiting",
  "  steps[2]{step,status,findings,duration_ms}:",
  "    intent,completed,0,89",
  "    review,completed,1,3928433",
  "outcome: passed"
].join("\n")

const terminal = (stdout: string): NoMistakesRunner => ({
  start: () => Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
  reattach: Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
  respond: () => Effect.die("no gate is parked"),
  answer: () => Effect.die("no question is open"),
  status: () => Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
  logs: () => Effect.succeed({ stdout: "findings: none", stderr: "", exitCode: 0 })
})

const finishedRun = (openQuestions: ReadonlyArray<OpenQuestion>): RunnerResult => ({
  task: "orc-128",
  pueueTask: 7,
  status: "failed",
  started: "2026-11-18T10:00:00.000Z",
  ended: "2026-11-18T10:00:05.000Z",
  reason: "orc exited 1",
  run: { id: "20261118-100000-abcdef", status: "failed", prLink: null, endReason: "no-mistakes stopped at the review gate. No PR opens.", openQuestions }
})

describe("a resumed run that stops at a gate orc cannot answer", () => {
  test("parks the gate for the owner instead of closing it failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-parked-gate-"))
    try {
      const record = await Effect.runPromise(driveNoMistakes({
        runner: terminal(refusedGate),
        taskFile: "/task.md",
        runDir: dir,
        answers: [{ question: "report-tail-misses-failures", answer: "B" }]
      }).pipe(Effect.provide(BunServices.layer)))
      expect(record.status).toBe("refused")
      expect(record.openQuestions).toEqual([{ id: "review-1", text: "needs a human" }])
      expect(record.result).toContain("review-1")
      expect(record.result).toContain("needs an answer orc cannot give")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("carries the run past the gate once the owner answers it instead of stopping it again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-parked-gate-"))
    try {
      const sent: Array<GateResponse> = []
      const runner: NoMistakesRunner = {
        ...terminal(completedRun),
        start: () => Effect.succeed({ stdout: refusedGate, stderr: "", exitCode: 0 }),
        respond: (response) => {
          sent.push(response)
          return Effect.succeed({ stdout: completedRun, stderr: "", exitCode: 0 })
        }
      }
      const record = await Effect.runPromise(driveNoMistakes({
        runner,
        taskFile: "/task.md",
        runDir: dir,
        answers: [{ question: "review-1", answer: "Keep the clause" }]
      }).pipe(Effect.provide(BunServices.layer)))
      expect(sent).toMatchObject([{ kind: "fix", ids: ["r1"] }])
      expect(sent[0]).not.toHaveProperty("instructions")
      expect(record.status).toBe("passed")
      expect(record.openQuestions).toEqual([])
      expect(record.result).toContain("CI is green")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("parks a failed run naming its gate instead of closing it failed", () => {
    const gate: OpenQuestion = { id: "review-1", text: "needs a human", asked: "2026-11-18T10:01:00.000Z", blocks: true }
    expect(endingFromResult(finishedRun([gate]), "ship")).toEqual({ kind: "park", questions: [gate] })
  })

  test("still closes a failed run with no question failed", () => {
    expect(endingFromResult(finishedRun([]), "ship")).toMatchObject({ kind: "close", outcome: "failed" })
  })

  test("waits on the parked gate instead of resuming while the gate is unchanged", async () => {
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
      const gate: OpenQuestion = { id: "review-1", text: "needs a human", asked: "2026-11-18T10:01:00.000Z", blocks: true }
      const parked = await run(parkStartedTask(root, id, "orc/test", Arr.make(gate), "2026-11-18T10:01:00.000Z", "run-1"))
      expect(answerWait(parked, () => false)).toBe("parked on orc/test for the captain's answer to review-1")
      await run(answerTask(root, id, "review-1=Keep it", "2026-11-18T10:02:00.000Z"))
      expect(answerWait(await run(findTask(root, id)), () => false)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports the gate once while later beats see it", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-parked-"))
    try {
      const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
        Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))
      const question = { id: "review-1", text: "needs a human", asked: "2026-11-18T10:01:00.000Z", blocks: true }
      await run(openReviewQuestions(root, "orc-128", [question]))
      await run(openReviewQuestions(root, "orc-128", [question]))
      const items = await run(openItems(root))
      expect(items).toHaveLength(1)
      expect(items[0]?.item).toMatchObject({ kind: "review-question", task: "orc-128", text: "needs a human", state: { kind: "open" } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
