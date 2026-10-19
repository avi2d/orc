import { Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import type { AgentFile } from "./agents"
import { orcCompletionLine, type PiTokenUse } from "./pi"
import { OrcRunError } from "./run-session"
import { formatHistoryError, recordEvidence, recordRun, recordSignal, recordStep } from "./run-history"

export interface OrcRunCommit {
  readonly sha: string
  readonly subject: string
}

export interface ChecksRoundSummary {
  readonly round: number
  readonly file: string
  readonly started: string
  readonly ended: string
  readonly passed: boolean
  readonly failed: ReadonlyArray<string>
  readonly checks: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>
}

export interface RecordedFixAttempt {
  readonly attempt: number
  readonly status: "passed" | "failed"
  readonly started: string
  readonly ended: string
  readonly agentFile: string
  readonly sessionFile: string | null
  readonly evidenceIn: string
  readonly commits: number
  readonly tokens: PiTokenUse | null
}

export interface OrcRunReport {
  readonly runId: string
  readonly runDir: string
  readonly branch: string
  readonly agentPath: string
  readonly agentSource: string
  readonly model: string
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly commits: ReadonlyArray<OrcRunCommit> | null
  readonly tokens: PiTokenUse | null
  readonly completed: boolean
  readonly markerVerified: boolean
  readonly implementPassed: boolean
  readonly checksRounds: ReadonlyArray<ChecksRoundSummary> | null
  readonly fixes: ReadonlyArray<RecordedFixAttempt>
  readonly fixAttempts: number
  readonly endReason: string
}

export const historyFailure = (action: string, cause: unknown): OrcRunError =>
  new OrcRunError({ message: "orc: cannot " + action + " the run history: " + formatHistoryError(cause) })

export const formatReport = (report: OrcRunReport): string =>
  [
    "run id: " + report.runId,
    "run folder: " + report.runDir,
    "branch: " + report.branch,
    "agent file: " + report.agentPath + " (" + report.agentSource + ")",
    "model: " + report.model,
    "pi session: " + (report.sessionId ?? "none"),
    "session file: " + (report.sessionFile ?? "none"),
    "commits: " + (report.commits === null ? "unknown" : report.commits.length.toString() + report.commits.map((commit) => " " + commit.sha).join(",")),
    "input tokens: " + (report.tokens === null ? "unknown" : report.tokens.input.toString()),
    "output tokens: " + (report.tokens === null ? "unknown" : report.tokens.output.toString()),
    "checks: " + (report.checksRounds === null
      ? "never ran"
      : report.checksRounds.length.toString() + (report.checksRounds.length === 1 ? " round" : " rounds") + ", " + report.fixAttempts.toString() + (report.fixAttempts === 1 ? " fix attempt" : " fix attempts")),
    "status: " + (report.completed ? "completed" : !report.markerVerified ? "incomplete" : (report.commits ?? []).length === 0 ? "no commit" : "checks failed"),
    report.endReason
  ].join("\n")

export interface HistoryRun {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly git: string
  readonly projectDir: string
  readonly runId: string
  readonly runDir: string
  readonly piSessionDir: string
  readonly hostSessionsDir: string
  readonly taskPath: string
  readonly agent: AgentFile
  readonly fixer: AgentFile
  readonly branch: string
  readonly started: string
  readonly worktreeDir: string
}

export const failedReport = (run: HistoryRun, reason: string): OrcRunReport => ({
  runId: run.runId,
  runDir: run.runDir,
  branch: run.branch,
  agentPath: run.agent.path,
  agentSource: run.agent.source,
  model: run.agent.model,
  sessionId: null,
  sessionFile: null,
  commits: null,
  tokens: null,
  completed: false,
  markerVerified: false,
  implementPassed: false,
  checksRounds: null,
  fixes: [],
  fixAttempts: 0,
  endReason: reason
})

export const writeEvidence = (run: HistoryRun, report: OrcRunReport): Effect.Effect<void, OrcRunError> => {
  const lines = [
    "Implement step for task " + run.taskPath + ".",
    "Agent file " + report.agentPath + " (" + report.agentSource + ") names model " + report.model + " with tools " + run.agent.tools.join(", ") + ".",
    report.sessionId === null ? "Pi stored no session." : "Pi session " + report.sessionId + " is stored at " + (report.sessionFile ?? "an unknown path") + ".",
    report.markerVerified ? "Pi printed " + orcCompletionLine + "." : "orc could not verify that Pi printed " + orcCompletionLine + ".",
    report.commits === null
      ? "orc could not tell which commits Pi made on " + report.branch + "."
      : report.commits.length === 0 ? "Pi made no commit on " + report.branch + "." : "Commits on " + report.branch + ".",
    ...(report.commits ?? []).map((commit) => commit.sha + " " + commit.subject),
    report.tokens === null
      ? "Pi's token use is unknown."
      : "Pi consumed " + report.tokens.input.toString() + " input tokens and " + report.tokens.output.toString() + " output tokens.",
    ...(report.checksRounds === null
      ? []
      : [
        "Checks ran " + report.checksRounds.length.toString() + (report.checksRounds.length === 1 ? " round" : " rounds") + " with " + report.fixAttempts.toString() + (report.fixAttempts === 1 ? " fix attempt" : " fix attempts") + ".",
        "Checks evidence: " + report.checksRounds.map((round) => run.path.basename(round.file)).join(", ") + "."
      ]),
    report.endReason
  ]
  return run.fs.writeFileString(run.path.join(run.runDir, "implement-1.md"), lines.join("\n") + "\n").pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the evidence file: " + String(cause) }))
  )
}

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
  })

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

const measuredSignals = (report: OrcRunReport): ReadonlyArray<{ readonly name: string; readonly value: string }> => [
  ...(report.tokens === null ? [] : [
    { name: "input-tokens", value: report.tokens.input.toString() },
    { name: "output-tokens", value: report.tokens.output.toString() }
  ]),
  ...(report.commits === null ? [] : [{ name: "commit-count", value: report.commits.length.toString() }])
]
