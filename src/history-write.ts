import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { NoMistakesRecord } from "./no-mistakes"
import { noMistakesFile, type HistoryRun } from "./run-record"
import type { ChecksRoundSummary, OrcRunReport, RecordedFixAttempt } from "./report"
import { OrcRunError } from "./run-session"
import { formatHistoryError, recordEvidence, recordRun, recordSignal, recordStep, stepIdFor, updateRun, updateStep } from "./run-history"
import { noMistakesSignals } from "./report"

export const recordRunStart = (db: Database, run: HistoryRun): Effect.Effect<void, OrcRunError> =>
  recordRun(db, { id: run.runId, project: run.projectDir, branch: run.branch, taskFile: run.taskPath, status: "running", started: run.started }).pipe(
    Effect.mapError((cause) => historyFailure("record the run in", cause))
  )

export const finishRun = (db: Database, runId: string, report: OrcRunReport, ended: string): Effect.Effect<void, OrcRunError> =>
  updateRun(db, runId, { status: report.completed ? "succeeded" : "failed", ended, prLink: report.prLink, endReason: report.endReason }).pipe(
    Effect.mapError((cause) => historyFailure("record the run in", cause))
  )

export const recordImplementStart = (db: Database, run: HistoryRun, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId: run.runId, name: "implement", attempt: 1, status: "running", started, agentFile: run.agent.path, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the step in", cause))
  )

export const recordChecksStart = (db: Database, runId: string, round: number, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "checks", attempt: round, status: "running", started, agentFile: null, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the checks step in", cause))
  )

export const recordFixStart = (db: Database, runId: string, attempt: number, agentFile: string, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "fix", attempt, status: "running", started, agentFile, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the fix step in", cause))
  )

export const recordNoMistakesStart = (db: Database, runId: string, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "no-mistakes", attempt: 1, status: "running", started, agentFile: null, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the no-mistakes step in", cause))
  )

export const recordImplementDone = (db: Database, run: HistoryRun, report: Pick<OrcRunReport, "agentPath" | "sessionFile" | "tokens" | "commits" | "implementPassed">, started: string, ended: string): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const status = report.implementPassed ? "passed" : "failed"
    const known = yield* stepIdFor(db, run.runId, "implement", 1).pipe(Effect.mapError(failed("read the step in")))
    const stepId = known ?? (yield* recordStep(db, { runId: run.runId, name: "implement", attempt: 1, status, started, ended, agentFile: report.agentPath, piSessionFile: report.sessionFile }).pipe(Effect.mapError(failed("record the step in"))))
    if (known !== null) {
      yield* updateStep(db, run.runId, "implement", 1, { status, ended, piSessionFile: report.sessionFile ?? undefined }).pipe(Effect.mapError(failed("record the step in")))
    }
    yield* recordEvidence(db, { stepId, direction: "in", path: run.taskPath, kind: "task" }).pipe(Effect.mapError(failed("record the task evidence in")))
    yield* recordEvidence(db, { stepId, direction: "out", path: run.path.join(run.runDir, "implement-1.md"), kind: "evidence" }).pipe(Effect.mapError(failed("record the evidence file in")))
    if (report.sessionFile !== null) {
      yield* recordEvidence(db, { stepId, direction: "out", path: report.sessionFile, kind: "session" }).pipe(Effect.mapError(failed("record the session evidence in")))
    }
    const signals: ReadonlyArray<{ readonly name: string; readonly value: string }> = [
      ...(report.tokens === null ? [] : [{ name: "input-tokens", value: report.tokens.input.toString() }, { name: "output-tokens", value: report.tokens.output.toString() }]),
      ...(report.commits === null ? [] : [{ name: "commit-count", value: report.commits.length.toString() }])
    ]
    for (const signal of signals) {
      yield* recordSignal(db, { stepId, name: signal.name, value: signal.value }).pipe(Effect.mapError(failed("record the signals in")))
    }
  })

export const recordChecksDone = (db: Database, runId: string, round: ChecksRoundSummary): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const status = round.passed ? "passed" : "failed"
    const known = yield* stepIdFor(db, runId, "checks", round.round).pipe(Effect.mapError(failed("read the checks step in")))
    const checksId = known ?? (yield* recordStep(db, { runId, name: "checks", attempt: round.round, status, started: round.started, ended: round.ended, agentFile: null, piSessionFile: null }).pipe(Effect.mapError(failed("record the checks step in"))))
    if (known !== null) {
      yield* updateStep(db, runId, "checks", round.round, { status, ended: round.ended }).pipe(Effect.mapError(failed("record the checks step in")))
    }
    yield* recordEvidence(db, { stepId: checksId, direction: "out", path: round.file, kind: "checks" }).pipe(Effect.mapError(failed("record the checks evidence in")))
    for (const check of round.checks) {
      yield* recordSignal(db, { stepId: checksId, name: "check " + check.name, value: check.passed ? "passed" : "failed" }).pipe(Effect.mapError(failed("record the check signals in")))
    }
  })

export const recordFixDone = (db: Database, runId: string, fix: RecordedFixAttempt): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const known = yield* stepIdFor(db, runId, "fix", fix.attempt).pipe(Effect.mapError(failed("read the fix step in")))
    const fixId = known ?? (yield* recordStep(db, { runId, name: "fix", attempt: fix.attempt, status: fix.status, started: fix.started, ended: fix.ended, agentFile: fix.agentFile, piSessionFile: fix.sessionFile }).pipe(Effect.mapError(failed("record the fix step in"))))
    if (known !== null) {
      yield* updateStep(db, runId, "fix", fix.attempt, { status: fix.status, ended: fix.ended, piSessionFile: fix.sessionFile ?? undefined }).pipe(Effect.mapError(failed("record the fix step in")))
    }
    yield* recordEvidence(db, { stepId: fixId, direction: "in", path: fix.evidenceIn, kind: "checks" }).pipe(Effect.mapError(failed("record the fix evidence in")))
    if (fix.sessionFile !== null) {
      yield* recordEvidence(db, { stepId: fixId, direction: "out", path: fix.sessionFile, kind: "session" }).pipe(Effect.mapError(failed("record the fix session in")))
    }
    yield* recordSignal(db, { stepId: fixId, name: "commit-count", value: fix.commits.toString() }).pipe(Effect.mapError(failed("record the fix signals in")))
    if (fix.tokens !== null) {
      yield* recordSignal(db, { stepId: fixId, name: "input-tokens", value: fix.tokens.input.toString() }).pipe(Effect.mapError(failed("record the fix signals in")))
      yield* recordSignal(db, { stepId: fixId, name: "output-tokens", value: fix.tokens.output.toString() }).pipe(Effect.mapError(failed("record the fix signals in")))
    }
  })

export const recordNoMistakesDone = (db: Database, run: HistoryRun, record: NoMistakesRecord): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const status = record.status === "passed" ? "passed" : "failed"
    const known = yield* stepIdFor(db, run.runId, "no-mistakes", 1).pipe(Effect.mapError(failed("read the no-mistakes step in")))
    const stepId = known ?? (yield* recordStep(db, { runId: run.runId, name: "no-mistakes", attempt: 1, status, started: record.started, ended: record.ended, agentFile: null, piSessionFile: null }).pipe(Effect.mapError(failed("record the no-mistakes step in"))))
    if (known !== null) {
      yield* updateStep(db, run.runId, "no-mistakes", 1, { status, ended: record.ended }).pipe(Effect.mapError(failed("record the no-mistakes step in")))
    }
    yield* recordEvidence(db, { stepId, direction: "in", path: run.taskPath, kind: "task" }).pipe(Effect.mapError(failed("record the task evidence in")))
    yield* recordEvidence(db, { stepId, direction: "out", path: noMistakesFile(run), kind: "no-mistakes" }).pipe(Effect.mapError(failed("record the no-mistakes evidence in")))
    for (const signal of noMistakesSignals(record)) {
      yield* recordSignal(db, { stepId, name: signal.name, value: signal.value }).pipe(Effect.mapError(failed("record the no-mistakes signals in")))
    }
  })

export const historyFailure = (action: string, cause: unknown): OrcRunError =>
  new OrcRunError({ message: "orc: cannot " + action + " the run history: " + formatHistoryError(cause) })
