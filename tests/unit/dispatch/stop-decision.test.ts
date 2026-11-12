import { describe, expect, test } from "bun:test"
import { endingFromResult } from "../../../packages/run/src/features/queueing-a-task/index"
import { ownLogEndingOf, staleEndingOf } from "../../../packages/run/src/widgets/beat/beat-close"

const oldStart = "2026-10-27T10:02:00.000Z"

describe("a stopped run", () => {
  const failedRun = { id: "run-1", status: "failed" as const, prLink: null, endReason: "the run was stopped", openQuestions: [] }
  test("a stopped run closes its task stopped instead of failed", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: { ...failedRun, status: "stopped" as const } }, "ship")).toEqual({
      kind: "close",
      outcome: "stopped",
      reason: "the run was stopped",
      pr: null,
      report: null
    })
  })
  test("a stopped close keeps the run PR instead of dropping it", () => {
    const stoppedRun = { ...failedRun, status: "stopped" as const, prLink: "https://github.com/example/orc/pull/7" }
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: stoppedRun }, "ship")).toEqual({
      kind: "close",
      outcome: "stopped",
      reason: "the run was stopped",
      pr: "https://github.com/example/orc/pull/7",
      report: null
    })
    expect(endingFromResult({ task: "orc-1", status: "unknown", run: stoppedRun }, "ship")).toEqual({
      kind: "close",
      outcome: "stopped",
      reason: "the run was stopped",
      pr: "https://github.com/example/orc/pull/7",
      report: null
    })
  })
  test("a failed run closes with its end reason instead of the bare pueue reason", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: failedRun }, "ship")).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the run was stopped",
      pr: null,
      report: null
    })
  })
  test("an unknown runner result with a stopped run closes stopped instead of failed", () => {
    expect(endingFromResult({ task: "orc-1", status: "unknown", run: { id: "run-1", status: "stopped", prLink: "https://github.com/example/orc/pull/7", endReason: "the run was stopped", openQuestions: [] } }, "ship")).toEqual({
      kind: "close",
      outcome: "stopped",
      reason: "the run was stopped",
      pr: "https://github.com/example/orc/pull/7",
      report: null
    })
  })
  test("a failed run with no end reason keeps the pueue reason instead of closing blank", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: { ...failedRun, endReason: null } }, "ship")).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "orc exited 1",
      pr: null,
      report: null
    })
  })
})

describe("the stale close decision", () => {
  const unknownReading = { kind: "read" as const, result: { task: "orc-1", status: "unknown" as const }, ending: null, outputAt: null, asking: null }
  test("an unseen runner record closes the task failed once the start outgrows the queue delay instead of waiting forever", () => {
    expect(staleEndingOf(oldStart, Date.parse("2026-11-07T10:00:00.000Z"), unknownReading, null)).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the runner holds no record of this task",
      pr: null,
      report: null
    })
  })
  test("an unseen runner record on a fresh start keeps running instead of closing on the first beat", () => {
    expect(staleEndingOf(new Date().toISOString(), Date.now(), unknownReading, null)).toBeNull()
  })
  test("an unread close that stays unread past the grace closes the task failed instead of retrying forever", () => {
    expect(staleEndingOf(oldStart, Date.parse("2026-11-07T10:00:00.000Z"), { kind: "unread", reason: "pueue status exited 3: pueue is down" }, Date.parse(oldStart))).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "pueue status exited 3: pueue is down",
      pr: null,
      report: null
    })
  })
  test("a first unread close waits for the next beat instead of closing failed", () => {
    expect(staleEndingOf(new Date().toISOString(), Date.now(), { kind: "unread", reason: "pueue is down" }, null)).toBeNull()
  })
  test("an unread close seen again before the grace waits instead of closing failed", () => {
    expect(staleEndingOf(oldStart, Date.now(), { kind: "unread", reason: "pueue is down" }, Date.now())).toBeNull()
  })
})

describe("the own-log close decision", () => {
  test("a quiet old log closes the task failed instead of staying started", () => {
    expect(ownLogEndingOf(oldStart, oldStart, Date.parse("2026-11-07T10:00:00.000Z"))).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the machine keeps its own log, and its log has not grown for 30 minutes",
      pr: null,
      report: null
    })
  })
  test("a missing log on an old start closes the task failed instead of staying started", () => {
    expect(ownLogEndingOf(oldStart, null, Date.parse("2026-11-07T10:00:00.000Z"))).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the machine keeps its own log, and its log has not grown for 30 minutes",
      pr: null,
      report: null
    })
  })
  test("a fresh log keeps the own-log task instead of closing it", () => {
    expect(ownLogEndingOf(oldStart, new Date().toISOString(), Date.now())).toBeNull()
  })
  test("an old log on a fresh start keeps the own-log task instead of closing it", () => {
    expect(ownLogEndingOf(new Date().toISOString(), oldStart, Date.now())).toBeNull()
  })
})
