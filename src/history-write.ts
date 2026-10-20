import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { NoMistakesRecord } from "./no-mistakes"
import { noMistakesFile, type HistoryRun } from "./run-record"
import type { ChecksRoundSummary, OrcRunReport, RecordedFixAttempt } from "./report"
import { OrcRunError } from "./run-session"
import { formatHistoryError, insertEvidence, insertRun, insertSignal, insertStep, recordEvidence, recordSignal, recordStep, stepIdFor, updateRun, updateStep } from "./run-history"
import type { EvidenceInput, SignalInput, StepInput } from "./run-history"
import { noMistakesSignals } from "./report"
import type { ResumePlan } from "./run-loop"

type EvidenceRow = Omit<EvidenceInput, "stepId">

type SignalRow = Omit<SignalInput, "stepId">

interface PlannedImplement {
  readonly step: StepInput
  readonly taskEvidence: EvidenceRow
  readonly evidenceFile: EvidenceRow
  readonly sessionEvidence: EvidenceRow | null
  readonly signals: ReadonlyArray<SignalRow>
}

interface PlannedChecks {
  readonly step: StepInput
  readonly checksEvidence: EvidenceRow
  readonly signals: ReadonlyArray<SignalRow>
}

interface PlannedFix {
  readonly step: StepInput
  readonly evidenceIn: EvidenceRow
  readonly sessionEvidence: EvidenceRow | null
  readonly commitSignal: SignalRow
  readonly tokenSignals: ReadonlyArray<SignalRow>
}

const planImplementDone = (
  run: HistoryRun,
  report: Pick<OrcRunReport, "agentPath" | "sessionFile" | "tokens" | "commits" | "implementPassed">,
  started: string,
  ended: string
): PlannedImplement => ({
  step: {
    runId: run.runId, name: "implement", attempt: 1,
    status: report.implementPassed ? "passed" : "failed",
    started, ended, agentFile: report.agentPath, piSessionFile: report.sessionFile
  },
  taskEvidence: { direction: "in", path: run.taskPath, kind: "task" },
  evidenceFile: { direction: "out", path: run.path.join(run.runDir, "implement-1.md"), kind: "evidence" },
  sessionEvidence: report.sessionFile === null
    ? null
    : { direction: "out", path: report.sessionFile, kind: "session" },
  signals: [
    ...(report.tokens === null
      ? []
      : [
        { name: "input-tokens", value: report.tokens.input.toString() },
        { name: "output-tokens", value: report.tokens.output.toString() }
      ]),
    ...(report.commits === null ? [] : [{ name: "commit-count", value: report.commits.length.toString() }])
  ]
})

const planChecksDone = (runId: string, round: ChecksRoundSummary): PlannedChecks => ({
  step: {
    runId, name: "checks", attempt: round.round,
    status: round.passed ? "passed" : "failed",
    started: round.started, ended: round.ended, agentFile: null, piSessionFile: null
  },
  checksEvidence: { direction: "out", path: round.file, kind: "checks" },
  signals: round.checks.map((check) => ({ name: "check " + check.name, value: check.passed ? "passed" : "failed" }))
})

const planFixDone = (runId: string, fix: RecordedFixAttempt): PlannedFix => ({
  step: {
    runId, name: "fix", attempt: fix.attempt, status: fix.status,
    started: fix.started, ended: fix.ended, agentFile: fix.agentFile, piSessionFile: fix.sessionFile
  },
  evidenceIn: { direction: "in", path: fix.evidenceIn, kind: "checks" },
  sessionEvidence: fix.sessionFile === null ? null : { direction: "out", path: fix.sessionFile, kind: "session" },
  commitSignal: { name: "commit-count", value: fix.commits.toString() },
  tokenSignals: fix.tokens === null
    ? []
    : [
      { name: "input-tokens", value: fix.tokens.input.toString() },
      { name: "output-tokens", value: fix.tokens.output.toString() }
    ]
})

const insertPlannedStep = (
  db: Database,
  step: StepInput,
  evidence: ReadonlyArray<EvidenceRow>,
  signals: ReadonlyArray<SignalRow>
): void => {
  const stepId = insertStep(db, step)
  for (const item of evidence) {
    insertEvidence(db, { stepId, ...item })
  }
  for (const signal of signals) {
    insertSignal(db, { stepId, ...signal })
  }
}

export const recordResumePublish = (db: Database, run: HistoryRun, resume: ResumePlan): Effect.Effect<void, OrcRunError> =>
  Effect.try({
    try: () => {
      const publish = db.transaction(() => {
        insertRun(db, {
          id: run.runId, project: run.projectDir, branch: run.branch,
          taskFile: run.taskPath, status: "running", started: run.started
        })
        if (resume.skipImplement) {
          const planned = planImplementDone(run, {
            agentPath: run.agent.path,
            sessionFile: resume.implementSessionFile,
            tokens: null, commits: null, implementPassed: true
          }, run.started, run.started)
          insertPlannedStep(db, planned.step, [
            planned.taskEvidence,
            planned.evidenceFile,
            ...(planned.sessionEvidence === null ? [] : [planned.sessionEvidence])
          ], planned.signals)
        }
        for (const round of resume.inheritedRounds) {
          const planned = planChecksDone(run.runId, round)
          insertPlannedStep(db, planned.step, [planned.checksEvidence], planned.signals)
        }
        for (const fix of resume.inheritedFixes) {
          const planned = planFixDone(run.runId, fix)
          insertPlannedStep(db, planned.step, [
            planned.evidenceIn,
            ...(planned.sessionEvidence === null ? [] : [planned.sessionEvidence])
          ], [planned.commitSignal, ...planned.tokenSignals])
        }
      })
      publish()
    },
    catch: (cause) => historyFailure("publish the resumed run in", cause)
  })

export const finishRun = (db: Database, runId: string, report: OrcRunReport, ended: string): Effect.Effect<void, OrcRunError> =>
  updateRun(db, runId, { status: report.completed ? "succeeded" : "failed", ended, prLink: report.prLink, endReason: report.endReason }).pipe(
    Effect.mapError((cause) => historyFailure("record the run in", cause))
  )

export const recordImplementStart = (db: Database, run: HistoryRun, started: string, piSessionFile?: string | null): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId: run.runId, name: "implement", attempt: 1, status: "running", started, agentFile: run.agent.path, piSessionFile: piSessionFile ?? null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the step in", cause))
  )

export const recordChecksStart = (db: Database, runId: string, round: number, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "checks", attempt: round, status: "running", started, agentFile: null, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the checks step in", cause))
  )

export const recordFixStart = (db: Database, runId: string, attempt: number, agentFile: string, started: string, piSessionFile?: string | null): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "fix", attempt, status: "running", started, agentFile, piSessionFile: piSessionFile ?? null }).pipe(
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
    const planned = planImplementDone(run, report, started, ended)
    const known = yield* stepIdFor(db, run.runId, "implement", 1).pipe(Effect.mapError(failed("read the step in")))
    const stepId = known ?? (yield* recordStep(db, planned.step).pipe(Effect.mapError(failed("record the step in"))))
    if (known !== null) {
      yield* updateStep(db, run.runId, "implement", 1, { status: planned.step.status, ended, piSessionFile: report.sessionFile ?? undefined }).pipe(Effect.mapError(failed("record the step in")))
    }
    yield* recordEvidence(db, { stepId, ...planned.taskEvidence }).pipe(Effect.mapError(failed("record the task evidence in")))
    yield* recordEvidence(db, { stepId, ...planned.evidenceFile }).pipe(Effect.mapError(failed("record the evidence file in")))
    if (planned.sessionEvidence !== null) {
      yield* recordEvidence(db, { stepId, ...planned.sessionEvidence }).pipe(Effect.mapError(failed("record the session evidence in")))
    }
    for (const signal of planned.signals) {
      yield* recordSignal(db, { stepId, name: signal.name, value: signal.value }).pipe(Effect.mapError(failed("record the signals in")))
    }
  })

export const recordChecksDone = (db: Database, runId: string, round: ChecksRoundSummary): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const planned = planChecksDone(runId, round)
    const known = yield* stepIdFor(db, runId, "checks", round.round).pipe(Effect.mapError(failed("read the checks step in")))
    const checksId = known ?? (yield* recordStep(db, planned.step).pipe(Effect.mapError(failed("record the checks step in"))))
    if (known !== null) {
      yield* updateStep(db, runId, "checks", round.round, { status: planned.step.status, ended: round.ended }).pipe(Effect.mapError(failed("record the checks step in")))
    }
    yield* recordEvidence(db, { stepId: checksId, ...planned.checksEvidence }).pipe(Effect.mapError(failed("record the checks evidence in")))
    for (const signal of planned.signals) {
      yield* recordSignal(db, { stepId: checksId, name: signal.name, value: signal.value }).pipe(Effect.mapError(failed("record the check signals in")))
    }
  })

export const recordFixDone = (db: Database, runId: string, fix: RecordedFixAttempt): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const planned = planFixDone(runId, fix)
    const known = yield* stepIdFor(db, runId, "fix", fix.attempt).pipe(Effect.mapError(failed("read the fix step in")))
    const fixId = known ?? (yield* recordStep(db, planned.step).pipe(Effect.mapError(failed("record the fix step in"))))
    if (known !== null) {
      yield* updateStep(db, runId, "fix", fix.attempt, { status: planned.step.status, ended: fix.ended, piSessionFile: fix.sessionFile ?? undefined }).pipe(Effect.mapError(failed("record the fix step in")))
    }
    yield* recordEvidence(db, { stepId: fixId, ...planned.evidenceIn }).pipe(Effect.mapError(failed("record the fix evidence in")))
    if (planned.sessionEvidence !== null) {
      yield* recordEvidence(db, { stepId: fixId, ...planned.sessionEvidence }).pipe(Effect.mapError(failed("record the fix session in")))
    }
    yield* recordSignal(db, { stepId: fixId, ...planned.commitSignal }).pipe(Effect.mapError(failed("record the fix signals in")))
    for (const signal of planned.tokenSignals) {
      yield* recordSignal(db, { stepId: fixId, ...signal }).pipe(Effect.mapError(failed("record the fix signals in")))
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
