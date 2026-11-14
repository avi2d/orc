import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { NoMistakesRecord, OpenQuestion } from "../../entities/review-gate/index"
import type { DirectPrRecord } from "../../entities/pull-request/index"
import { noMistakesFile, prBodyFileName, type HistoryRun } from "./run-record"
import { refusalSignalName, refusalValue } from "../../entities/run-history/index"
import type { ChecksRoundSummary, OrcRunReport, RecordedFixAttempt } from "../../entities/run-history/index"
import { OrcRunError } from "../../shared/lib/index"
import { historyFailure, insertEvidence, insertRun, insertSignal, insertStep, recordEvidence, recordSignal, recordStep, sqlite, stepIdFor, updateRun, updateStep } from "../../entities/run-history/index"
import type { EvidenceInput, SignalInput, StepInput } from "../../entities/run-history/index"
import { measuredSignals, noMistakesSignals, openQuestionSignal } from "../../entities/run-history/index"
import type { AgentStep, ResumePlan } from "./run-ops"
import type { AgentFile } from "../../entities/agent/index"
import { taskOfBranch } from "../../entities/backlog/index"

type StepAgent = Pick<AgentFile, "model" | "thinking">

const stepAgent = (agent: StepAgent): Pick<StepInput, "model" | "thinking"> => ({ model: agent.model, thinking: agent.thinking })

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
  report: Pick<OrcRunReport, "agentPath" | "sessionFile" | "tokens" | "commits" | "sessionSize" | "implementPassed">,
  started: string,
  ended: string,
  inherited: { readonly agentFile: string | null; readonly model: string | null; readonly thinking: string | null } | null = null
): PlannedImplement => ({
  step: {
    runId: run.runId, name: "implement", attempt: 1,
    status: report.implementPassed ? "passed" : "failed",
    started, ended, agentFile: inherited === null ? report.agentPath : inherited.agentFile, piSessionFile: report.sessionFile, model: inherited === null ? run.agent.model : inherited.model, thinking: inherited === null ? run.agent.thinking : inherited.thinking
  },
  taskEvidence: { direction: "in", path: run.taskPath, kind: "task" },
  evidenceFile: { direction: "out", path: run.path.join(run.runDir, "implement-1.md"), kind: "evidence" },
  sessionEvidence: report.sessionFile === null
    ? null
    : { direction: "out", path: report.sessionFile, kind: "session" },
  signals: measuredSignals(report)
})

const planChecksDone = (runId: string, round: ChecksRoundSummary): PlannedChecks => ({
  step: {
    runId, name: "checks", attempt: round.round,
    status: round.passed ? "passed" : "failed",
    started: round.started, ended: round.ended, agentFile: null, piSessionFile: null
  },
  checksEvidence: { direction: "out", path: round.file, kind: "checks" },
  signals: [
    ...round.checks.map((check) => ({ name: "check " + check.name, value: check.passed ? "passed" : "failed" as const })),
    ...round.refusals.map((refusal) => ({ name: refusalSignalName, value: refusalValue(refusal) }))
  ]
})

const planFixDone = (runId: string, fix: RecordedFixAttempt): PlannedFix => ({
  step: {
    runId, name: "fix", attempt: fix.attempt, status: fix.status,
    started: fix.started, ended: fix.ended, agentFile: fix.agentFile, piSessionFile: fix.sessionFile, model: fix.model, thinking: fix.thinking
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

const inheritedLog = (db: Database, run: HistoryRun, priorDir: string, name: "implement" | "fix", attempt: number): string => {
  const row = db.query("SELECT evidence.path FROM steps JOIN evidence ON evidence.step_id = steps.id WHERE steps.run_id = ? AND steps.name = ? AND steps.attempt = ? AND evidence.direction = 'out' AND evidence.kind = 'log' ORDER BY steps.id DESC, evidence.id DESC LIMIT 1")
    .get(run.path.basename(priorDir), name, attempt)
  if (typeof row === "object" && row !== null && "path" in row && typeof row.path === "string") {
    return row.path
  }
  return run.path.join(priorDir, name === "implement" ? "agent.log" : "fix-" + attempt.toString() + ".log")
}

export const recordResumePublish = (db: Database, run: HistoryRun, resume: ResumePlan): Effect.Effect<void, OrcRunError> =>
  Effect.try({
    try: () => {
      const publish = db.transaction(() => {
        insertRun(db, {
          id: run.runId, project: run.projectDir, branch: run.branch,
          taskFile: run.taskPath, status: "running", started: run.started, sandbox: run.sandbox,
          kind: "ship", delivery: run.delivery.kind,
          task: taskOfBranch(run.branch), machine: run.machine ?? null, worktree: run.worktreeDir
        })
        if (resume.skipImplement) {
          const planned = planImplementDone(run, {
            agentPath: run.agent.path,
            sessionFile: resume.implementSessionFile,
            tokens: null, commits: null, sessionSize: null, implementPassed: true
          }, run.started, run.started, resume.inheritedImplement)
          insertPlannedStep(db, planned.step, [
            planned.taskEvidence,
            planned.evidenceFile,
            ...(planned.sessionEvidence === null ? [] : [planned.sessionEvidence]),
            ...(resume.priorDir === null ? [] : [{ direction: "out" as const, path: inheritedLog(db, run, resume.priorDir, "implement", 1), kind: "log" }])
          ], planned.signals)
        } else {
          insertStep(db, { runId: run.runId, name: "implement", attempt: 1, status: "running", started: run.started, agentFile: run.agent.path, piSessionFile: resume.implementSessionFile, ...stepAgent(run.agent) })
        }
        if (resume.fixRunning && resume.fixSessionFile !== null) {
          insertStep(db, { runId: run.runId, name: "fix", attempt: resume.inheritedFixes.length + 1, status: "running", started: run.started, agentFile: run.fixer.path, piSessionFile: resume.fixSessionFile, ...stepAgent(run.fixer) })
        }
        for (const round of resume.inheritedRounds) {
          const planned = planChecksDone(run.runId, round)
          insertPlannedStep(db, planned.step, [planned.checksEvidence], planned.signals.filter((signal) => signal.name !== refusalSignalName))
        }
        for (const fix of resume.inheritedFixes) {
          const planned = planFixDone(run.runId, fix)
          insertPlannedStep(db, planned.step, [
            planned.evidenceIn,
            ...(planned.sessionEvidence === null ? [] : [planned.sessionEvidence]),
            ...(resume.priorDir === null ? [] : [{ direction: "out" as const, path: inheritedLog(db, run, resume.priorDir, "fix", fix.attempt), kind: "log" }])
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
  Effect.gen(function*() {
    const known = yield* stepIdFor(db, run.runId, "implement", 1).pipe(Effect.mapError((cause) => historyFailure("read the step in", cause)))
    if (known !== null) {
      yield* updateStep(db, run.runId, "implement", 1, { status: "running", ended: null, piSessionFile: piSessionFile ?? undefined }).pipe(Effect.mapError((cause) => historyFailure("record the step in", cause)))
      return
    }
    yield* recordStep(db, { runId: run.runId, name: "implement", attempt: 1, status: "running", started, agentFile: run.agent.path, piSessionFile: piSessionFile ?? null, ...stepAgent(run.agent) }).pipe(Effect.asVoid, Effect.mapError((cause) => historyFailure("record the step in", cause)))
  })

export const recordStepSession = (db: Database, runId: string, name: "implement" | "fix", attempt: number, piSessionFile: string): Effect.Effect<void, OrcRunError> =>
  updateStep(db, runId, name, attempt, { status: "running", ended: null, piSessionFile }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the session file in", cause))
  )

export const recordLoopQuestion = (db: Database, runId: string, step: AgentStep, question: OpenQuestion): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const stepId = yield* stepIdFor(db, runId, step.name, step.attempt).pipe(Effect.mapError((cause) => historyFailure("read the step in", cause)))
    if (stepId === null) {
      return yield* new OrcRunError({ message: "orc: the run history holds no " + step.name + " step " + step.attempt.toString() + " of run " + runId + " to ask " + question.id + " on" })
    }
    yield* recordSignal(db, { stepId, name: openQuestionSignal, value: JSON.stringify(question) }).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => historyFailure("record the question in", cause))
    )
  })

export const recordHandoverEvidence = (db: Database, runId: string, path: string): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const stepId = yield* stepIdFor(db, runId, "implement", 1).pipe(Effect.mapError((cause) => historyFailure("read the step in", cause)))
    if (stepId === null) {
      return
    }
    yield* recordEvidence(db, { stepId, direction: "out", path, kind: "handover" }).pipe(
      Effect.mapError((cause) => historyFailure("record the handover evidence in", cause))
    )
  })

export const recordChecksStart = (db: Database, runId: string, round: number, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "checks", attempt: round, status: "running", started, agentFile: null, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the checks step in", cause))
  )

export const recordFixStart = (db: Database, runId: string, attempt: number, agent: Pick<AgentFile, "path" | "model" | "thinking">, started: string, piSessionFile?: string | null): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const known = yield* stepIdFor(db, runId, "fix", attempt).pipe(Effect.mapError((cause) => historyFailure("read the fix step in", cause)))
    if (known !== null) {
      yield* updateStep(db, runId, "fix", attempt, { status: "running", ended: null, piSessionFile: piSessionFile ?? undefined, agentFile: agent.path, model: agent.model, thinking: agent.thinking }).pipe(Effect.mapError((cause) => historyFailure("record the fix step in", cause)))
      yield* sqlite(() => db.query("DELETE FROM evidence WHERE step_id = ? AND direction = ? AND kind = ?").run(known, "out", "log")).pipe(Effect.mapError((cause) => historyFailure("reset the fix log in", cause)))
      return
    }
    yield* recordStep(db, { runId, name: "fix", attempt, status: "running", started, agentFile: agent.path, piSessionFile: piSessionFile ?? null, ...stepAgent(agent) }).pipe(Effect.asVoid, Effect.mapError((cause) => historyFailure("record the fix step in", cause)))
  })

export const recordNoMistakesStart = (db: Database, runId: string, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "no-mistakes", attempt: 1, status: "running", started, agentFile: null, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the no-mistakes step in", cause))
  )

export const recordImplementDone = (db: Database, run: HistoryRun, report: Pick<OrcRunReport, "agentPath" | "sessionFile" | "tokens" | "commits" | "sessionSize" | "implementPassed">, started: string, ended: string): Effect.Effect<void, OrcRunError> =>
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
      yield* updateStep(db, runId, "fix", fix.attempt, { status: planned.step.status, ended: fix.ended, piSessionFile: fix.sessionFile ?? undefined, agentFile: planned.step.agentFile, model: planned.step.model, thinking: planned.step.thinking }).pipe(Effect.mapError(failed("record the fix step in")))
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

export const recordPullRequestStart = (db: Database, runId: string, started: string): Effect.Effect<void, OrcRunError> =>
  recordStep(db, { runId, name: "pr", attempt: 1, status: "running", started, agentFile: null, piSessionFile: null }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => historyFailure("record the pr step in", cause))
  )

export const recordPullRequestDone = (db: Database, run: HistoryRun, record: DirectPrRecord): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    const status = record.status === "opened" ? "passed" : "failed"
    const known = yield* stepIdFor(db, run.runId, "pr", 1).pipe(Effect.mapError(failed("read the pr step in")))
    const stepId = known ?? (yield* recordStep(db, { runId: run.runId, name: "pr", attempt: 1, status, started: record.started, ended: record.ended, agentFile: null, piSessionFile: null }).pipe(Effect.mapError(failed("record the pr step in"))))
    if (known !== null) {
      yield* updateStep(db, run.runId, "pr", 1, { status, ended: record.ended }).pipe(Effect.mapError(failed("record the pr step in")))
    }
    yield* recordEvidence(db, { stepId, direction: "in", path: run.path.join(run.runDir, prBodyFileName), kind: "pr-body" }).pipe(Effect.mapError(failed("record the pr evidence in")))
    if (record.prLink !== null) {
      yield* recordSignal(db, { stepId, name: "pr-link", value: record.prLink }).pipe(Effect.mapError(failed("record the pr signals in")))
    }
  })
