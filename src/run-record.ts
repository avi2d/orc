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
    "status: " + (report.completed ? "completed" : report.markerVerified ? "no commit" : "incomplete"),
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
  readonly branch: string
  readonly started: string
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
      status: report.completed ? "passed" : "failed",
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
  })

const measuredSignals = (report: OrcRunReport): ReadonlyArray<{ readonly name: string; readonly value: string }> => [
  ...(report.tokens === null ? [] : [
    { name: "input-tokens", value: report.tokens.input.toString() },
    { name: "output-tokens", value: report.tokens.output.toString() }
  ]),
  ...(report.commits === null ? [] : [{ name: "commit-count", value: report.commits.length.toString() }])
]
