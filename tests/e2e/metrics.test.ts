import { runOrc } from "./orc-process"
import { Effect } from "effect"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { Database } from "bun:sqlite"
import { openDatabase, recordEvidence, recordRun, recordSignal, recordStep, type RunRecord } from "../../packages/run/src/entities/run-history/index"
import { decodeMetricsJson } from "../../packages/run/src/features/seeing-runs/index"

const withHistory = async (use: (home: string) => Promise<void>, seed = fixtureRuns): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-metrics-e2e-"))
  try {
    const db = await Effect.runPromise(openDatabase(join(home, ".orc")).pipe(Effect.provide(BunServices.layer)))
    try {
      await Effect.runPromise(seed(db))
    } finally {
      db.close()
    }
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const runsDir = "/tmp/metrics-home/runs/"

interface FixtureStep {
  readonly name: string
  readonly attempt: number
  readonly status: "passed" | "failed"
  readonly at: string
  readonly signals?: ReadonlyArray<readonly [string, string]>
  readonly out?: { readonly kind: string; readonly path: string }
}

const fixtureRun = (db: Database, run: { readonly id: string; readonly status: RunRecord["status"]; readonly started: string; readonly ended: string; readonly delivery?: RunRecord["delivery"] }, steps: ReadonlyArray<FixtureStep>) =>
  Effect.gen(function*() {
    yield* recordRun(db, { id: run.id, project: "orc", branch: "orc/" + run.id, taskFile: runsDir + run.id + "/task.md", status: run.status, started: run.started, ended: run.ended, prLink: null, endReason: null, task: run.id, delivery: run.delivery ?? "orc" })
    for (const step of steps) {
      const stepId = yield* recordStep(db, { runId: run.id, name: step.name, attempt: step.attempt, status: step.status, started: step.at, ended: step.at, agentFile: null, piSessionFile: null })
      for (const [name, value] of step.signals ?? []) {
        yield* recordSignal(db, { stepId, name, value })
      }
      if (step.out !== undefined) {
        yield* recordEvidence(db, { stepId, direction: "out", ...step.out })
      }
    }
  })

const fixtureRuns = (db: Database) =>
  Effect.gen(function*() {
    yield* fixtureRun(db, { id: "delivered", status: "succeeded", started: "2026-11-20T10:00:00.000Z", ended: "2026-11-20T10:42:00.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-20T10:01:00.000Z" },
      { name: "checks", attempt: 1, status: "failed", at: "2026-11-20T10:10:00.000Z", signals: [["check lint", "failed"], ["check test", "passed"]] },
      { name: "fix", attempt: 1, status: "passed", at: "2026-11-20T10:15:00.000Z" },
      { name: "checks", attempt: 2, status: "failed", at: "2026-11-20T10:20:00.000Z", signals: [["check lint", "passed"], ["check test", "failed"]] },
      { name: "fix", attempt: 2, status: "passed", at: "2026-11-20T10:25:00.000Z" },
      { name: "checks", attempt: 3, status: "passed", at: "2026-11-20T10:30:00.000Z", signals: [["check lint", "passed"], ["check test", "passed"]] },
      { name: "review", attempt: 1, status: "passed", at: "2026-11-20T10:35:00.000Z" },
      { name: "pr", attempt: 1, status: "passed", at: "2026-11-20T10:40:00.000Z" }
    ])
    yield* fixtureRun(db, { id: "gate-stopped", status: "failed", delivery: "no-mistakes", started: "2026-11-21T11:00:00.000Z", ended: "2026-11-21T11:15:30.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-21T11:01:00.000Z" },
      { name: "checks", attempt: 1, status: "passed", at: "2026-11-21T11:05:00.000Z", signals: [["check test", "passed"]] },
      { name: "no-mistakes", attempt: 1, status: "failed", at: "2026-11-21T11:15:00.000Z", signals: [["gates-answered", "1"], ["gate", "review"]] }
    ])
    yield* fixtureRun(db, { id: "resumed", status: "failed", started: "2026-11-22T12:00:00.000Z", ended: "2026-11-22T12:07:00.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-19T09:01:00.000Z" },
      { name: "checks", attempt: 1, status: "failed", at: "2026-11-19T09:05:00.000Z", signals: [["check typecheck", "failed"]], out: { kind: "checks", path: runsDir + "earlier/session/checks-1.txt" } },
      { name: "fix", attempt: 1, status: "passed", at: "2026-11-19T09:10:00.000Z", out: { kind: "log", path: runsDir + "earlier/fix-1.log" } },
      { name: "checks", attempt: 2, status: "failed", at: "2026-11-22T12:02:00.000Z", signals: [["check typecheck", "failed"]] },
      { name: "fix", attempt: 2, status: "passed", at: "2026-11-22T12:04:00.000Z" },
      { name: "checks", attempt: 3, status: "failed", at: "2026-11-22T12:06:00.000Z", signals: [["check typecheck", "failed"], ["check test", "passed"]] }
    ])
  })

const expectedRows = [
  { run: "resumed", task: "resumed", delivery: "orc", status: "failed", failedSteps: 2, gateStops: 2, minutes: 7, fixRounds: 1 },
  { run: "gate-stopped", task: "gate-stopped", delivery: "no-mistakes", status: "failed", failedSteps: 1, gateStops: 2, minutes: 15.5, fixRounds: 0 },
  { run: "delivered", task: "delivered", delivery: "orc", status: "succeeded", failedSteps: 2, gateStops: 2, minutes: 42, fixRounds: 2 }
] as const

const fixtureGateRuns = (db: Database) =>
  Effect.gen(function*() {
    yield* fixtureRun(db, { id: "answered-two", delivery: "no-mistakes", status: "succeeded", started: "2026-11-23T10:00:00.000Z", ended: "2026-11-23T10:10:00.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-23T10:01:00.000Z" },
      { name: "no-mistakes", attempt: 1, status: "passed", at: "2026-11-23T10:09:00.000Z", signals: [["gates-answered", "2"]] }
    ])
    yield* fixtureRun(db, { id: "stopped-unanswered", delivery: "no-mistakes", status: "failed", started: "2026-11-24T10:00:00.000Z", ended: "2026-11-24T10:10:00.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-24T10:01:00.000Z" },
      { name: "no-mistakes", attempt: 1, status: "failed", at: "2026-11-24T10:09:00.000Z", signals: [["gates-answered", "0"], ["gate", "review"]] }
    ])
    yield* fixtureRun(db, { id: "implement-failed", status: "failed", started: "2026-11-25T10:00:00.000Z", ended: "2026-11-25T10:10:00.000Z" }, [
      { name: "implement", attempt: 1, status: "failed", at: "2026-11-25T10:09:00.000Z" }
    ])
    yield* fixtureRun(db, { id: "fix-failed", status: "failed", started: "2026-11-26T10:00:00.000Z", ended: "2026-11-26T10:10:00.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-26T10:01:00.000Z" },
      { name: "checks", attempt: 1, status: "failed", at: "2026-11-26T10:05:00.000Z", signals: [["check lint", "failed"], ["check test", "failed"]] },
      { name: "fix", attempt: 1, status: "failed", at: "2026-11-26T10:09:00.000Z" }
    ])
    yield* fixtureRun(db, { id: "no-gate-failed", delivery: "no-mistakes", status: "failed", started: "2026-11-27T10:00:00.000Z", ended: "2026-11-27T10:10:00.000Z" }, [
      { name: "implement", attempt: 1, status: "passed", at: "2026-11-27T10:01:00.000Z" },
      { name: "no-mistakes", attempt: 1, status: "failed", at: "2026-11-27T10:09:00.000Z", signals: [["gates-answered", "0"]] }
    ])
  })

const metricsRuns = async (home: string) => {
  const result = await runOrc(["metrics", "--json"], home)
  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.startsWith('{"schema":"orc.metrics.v2"')).toBe(true)
  return (await Effect.runPromise(decodeMetricsJson(JSON.parse(result.stdout)))).runs
}

const printedRows = (stdout: string): ReadonlyArray<ReadonlyArray<string>> =>
  stdout.trimEnd().split("\n").map((line) => line.split(/ {2,}/))

describe("orc metrics", () => {
  test("the JSON keeps recovered gate stops without counting carried steps or step time as run minutes", async () => {
    await withHistory(async (home) => {
      expect(await metricsRuns(home)).toEqual(expectedRows)
    })
  }, 30_000)

  test("the table prints the same counts per run rather than a resumed run's two fix rounds or three failed steps", async () => {
    await withHistory(async (home) => {
      const result = await runOrc(["metrics"], home)
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(printedRows(result.stdout)).toEqual([
        ["RUN", "TASK", "DELIVERY", "STATUS", "FAILED STEPS", "GATE STOPS", "MINUTES", "FIX ROUNDS"],
        ["resumed", "resumed", "orc", "failed", "2", "2", "7.0", "1"],
        ["gate-stopped", "gate-stopped", "no-mistakes", "failed", "1", "2", "15.5", "0"],
        ["delivered", "delivered", "orc", "succeeded", "2", "2", "42.0", "2"]
      ])
    })
  }, 30_000)

  test("answered gates and a final unanswered gate count without treating implement, fix or no-gate failures as gates", async () => {
    await withHistory(async (home) => {
      expect(await metricsRuns(home)).toEqual([
        { run: "no-gate-failed", task: "no-gate-failed", delivery: "no-mistakes", status: "failed", failedSteps: 1, gateStops: 0, minutes: 10, fixRounds: 0 },
        { run: "fix-failed", task: "fix-failed", delivery: "orc", status: "failed", failedSteps: 2, gateStops: 1, minutes: 10, fixRounds: 1 },
        { run: "implement-failed", task: "implement-failed", delivery: "orc", status: "failed", failedSteps: 1, gateStops: 0, minutes: 10, fixRounds: 0 },
        { run: "stopped-unanswered", task: "stopped-unanswered", delivery: "no-mistakes", status: "failed", failedSteps: 1, gateStops: 1, minutes: 10, fixRounds: 0 },
        { run: "answered-two", task: "answered-two", delivery: "no-mistakes", status: "succeeded", failedSteps: 0, gateStops: 2, minutes: 10, fixRounds: 0 }
      ])
    }, fixtureGateRuns)
  }, 30_000)

  test("an empty history prints that no runs are recorded instead of a bare header", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-metrics-e2e-"))
    try {
      const result = await runOrc(["metrics"], home)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("no runs recorded")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
})
