import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { NoMistakesRecord } from "./no-mistakes"
import type { HistoryRun } from "./run-record"
import type { ChecksRoundSummary, OrcRunReport, RecordedFixAttempt } from "./report"
import { OrcRunError } from "./run-session"
import { formatHistoryError, recordEvidence, recordRun, recordSignal, recordStep } from "./run-history"
import { measuredSignals, noMistakesSignals } from "./report"

export const historyFailure = (action: string, cause: unknown): OrcRunError =>
  new OrcRunError({ message: "orc: cannot " + action + " the run history: " + formatHistoryError(cause) })

export const recordHistory = (
  db: Database,
  run: HistoryRun,
  report: OrcRunReport
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const ended = new Date().toISOString()
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    yield* recordRun(db, {
      id: run.runId,
      project: run.projectDir,
      branch: report.branch,
      taskFile: run.taskPath,
      status: report.completed ? "succeeded" : "failed",
      started: run.started,
      ended,
      prLink: report.prLink,
      endReason: report.endReason
    }).pipe(Effect.mapError(failed("record the run in")))
    const stepId = yield* recordStep(db, {
      runId: run.runId,
      name: "implement",
      attempt: 1,
      status: report.implementPassed ? "passed" : "failed",
      started: run.started,
      ended,
      agentFile: report.agentPath,
      piSessionFile: report.sessionFile
    }).pipe(Effect.mapError(failed("record the step in")))
    yield* recordEvidence(db, { stepId, direction: "in", path: run.taskPath, kind: "task" }).pipe(
      Effect.mapError(failed("record the task evidence in"))
    )
    yield* recordEvidence(db, { stepId, direction: "out", path: run.path.join(run.runDir, "implement-1.md"), kind: "evidence" }).pipe(
      Effect.mapError(failed("record the evidence file in"))
    )
    if (report.sessionFile !== null) {
      yield* recordEvidence(db, { stepId, direction: "out", path: report.sessionFile, kind: "session" }).pipe(
        Effect.mapError(failed("record the session evidence in"))
      )
    }
    for (const signal of measuredSignals(report)) {
      yield* recordSignal(db, { stepId, name: signal.name, value: signal.value }).pipe(
        Effect.mapError(failed("record the signals in"))
      )
    }
    for (const round of report.checksRounds ?? []) {
      yield* recordChecksRound(db, run, round, failed)
    }
    for (const fix of report.fixes) {
      yield* recordFixAttempt(db, run, fix, failed)
    }
    if (report.noMistakes !== null) {
      yield* recordNoMistakesStep(db, run, report.noMistakes, failed)
    }
  })

const recordNoMistakesStep = (
  db: Database,
  run: HistoryRun,
  record: NoMistakesRecord,
  failed: (action: string) => (cause: unknown) => OrcRunError
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const stepId = yield* recordStep(db, {
      runId: run.runId,
      name: "no-mistakes",
      attempt: 1,
      status: record.status === "passed" ? "passed" : "failed",
      started: record.started,
      ended: record.ended,
      agentFile: null,
      piSessionFile: null
    }).pipe(Effect.mapError(failed("record the no-mistakes step in")))
    yield* recordEvidence(db, { stepId, direction: "in", path: run.taskPath, kind: "task" }).pipe(
      Effect.mapError(failed("record the task evidence in"))
    )
    yield* recordEvidence(db, { stepId, direction: "out", path: noMistakesFile(run), kind: "no-mistakes" }).pipe(
      Effect.mapError(failed("record the no-mistakes evidence in"))
    )
    for (const signal of noMistakesSignals(record)) {
      yield* recordSignal(db, { stepId, name: signal.name, value: signal.value }).pipe(
        Effect.mapError(failed("record the no-mistakes signals in"))
      )
    }
  })

const noMistakesFile = (run: HistoryRun): string => run.path.join(run.runDir, "no-mistakes.txt")

const recordChecksRound = (
  db: Database,
  run: HistoryRun,
  round: ChecksRoundSummary,
  failed: (action: string) => (cause: unknown) => OrcRunError
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const checksId = yield* recordStep(db, {
      runId: run.runId,
      name: "checks",
      attempt: round.round,
      status: round.passed ? "passed" : "failed",
      started: round.started,
      ended: round.ended,
      agentFile: null,
      piSessionFile: null
    }).pipe(Effect.mapError(failed("record the checks step in")))
    yield* recordEvidence(db, { stepId: checksId, direction: "out", path: round.file, kind: "checks" }).pipe(
      Effect.mapError(failed("record the checks evidence in"))
    )
    for (const check of round.checks) {
      yield* recordSignal(db, { stepId: checksId, name: "check " + check.name, value: check.passed ? "passed" : "failed" }).pipe(
        Effect.mapError(failed("record the check signals in"))
      )
    }
  })

const recordFixAttempt = (
  db: Database,
  run: HistoryRun,
  fix: RecordedFixAttempt,
  failed: (action: string) => (cause: unknown) => OrcRunError
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const fixId = yield* recordStep(db, {
      runId: run.runId,
      name: "fix",
      attempt: fix.attempt,
      status: fix.status,
      started: fix.started,
      ended: fix.ended,
      agentFile: fix.agentFile,
      piSessionFile: fix.sessionFile
    }).pipe(Effect.mapError(failed("record the fix step in")))
    yield* recordEvidence(db, { stepId: fixId, direction: "in", path: fix.evidenceIn, kind: "checks" }).pipe(
      Effect.mapError(failed("record the fix evidence in"))
    )
    if (fix.sessionFile !== null) {
      yield* recordEvidence(db, { stepId: fixId, direction: "out", path: fix.sessionFile, kind: "session" }).pipe(
        Effect.mapError(failed("record the fix session in"))
      )
    }
    yield* recordSignal(db, { stepId: fixId, name: "commit-count", value: fix.commits.toString() }).pipe(
      Effect.mapError(failed("record the fix signals in"))
    )
    for (const signal of fixTokenSignals(fix)) {
      yield* recordSignal(db, { stepId: fixId, name: signal.name, value: signal.value }).pipe(
        Effect.mapError(failed("record the fix signals in"))
      )
    }
  })

const fixTokenSignals = (fix: RecordedFixAttempt): ReadonlyArray<{ readonly name: string; readonly value: string }> =>
  fix.tokens === null ? [] : [
    { name: "input-tokens", value: fix.tokens.input.toString() },
    { name: "output-tokens", value: fix.tokens.output.toString() }
  ]
