import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { askSetupFor } from "../../packages/run/src/entities/agent/index"
import type { OpenQuestion } from "../../packages/run/src/entities/review-gate/index"
import { endingFromResult, type RunnerResult } from "../../packages/run/src/features/queueing-a-task/index"
import { recordOpenAsks } from "../../packages/run/src/features/running-a-task/history-write"

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
  test("does not park again on a question its answers settled, which left nothing open and restarted the task every beat", () => {
    const recorded = recordedBy([answered])
    expect(recorded).toEqual([])
    expect(endingFromResult(finishedRun(recorded), "ship")).toEqual({ kind: "close", outcome: "failed", reason: gateStop, pr: null, report: null })
  })

  test("still parks on a question of the resumed run that no answer settled, rather than dropping it", () => {
    const recorded = recordedBy([answered, unanswered])
    expect(recorded).toEqual([unanswered])
    expect(endingFromResult(finishedRun(recorded), "ship")).toEqual({ kind: "park", questions: [unanswered] })
  })
})
