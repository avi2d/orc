import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentExec } from "./agent-exec"
import type { AgentFile } from "./agents"
import type { SandboxKind } from "./sandbox-kind"
import { orcCompletionLine } from "./pi"
import { idleSpan, type PiPacing, runPi } from "./pi-run"
import { historyFailure, recordRun, updateRun } from "./run-history"
import type { OrcRunError } from "./shared/lib/index"
import { reportPathOf, writtenReport } from "./report"
import type { ReportKind } from "./task-kind"

export interface ReportRun {
  readonly kind: ReportKind
  readonly runId: string
  readonly runDir: string
  readonly projectDir: string
  readonly branch: string
  readonly sandbox: SandboxKind
  readonly taskPath: string
  readonly instructions: string | null
  readonly hostSessionsDir: string
  readonly agent: AgentFile
  readonly started: string
  readonly exec: AgentExec
  readonly pacing: PiPacing
}

export type ReportOutcome =
  | { readonly kind: "reported"; readonly runId: string; readonly report: string }
  | { readonly kind: "unreported"; readonly runId: string; readonly reason: string }

const kindAsks: Record<ReportKind, string> = {
  scout: "Read the checkout and change nothing in it.",
  task: "Do what it asks; when it asks for evidence, put that evidence in the report.",
  parent: "This is the final check of a parent task whose ship children have all merged and whose scout and task children have all closed done. Change nothing in the checkout and review no code. " +
    "Run the whole result once in the real place it serves, check each done criterion the task names, and put that evidence in the report. " +
    "End the report with the line verdict: pass when every criterion holds, or verdict: fail when any does not."
}

const passLine = "verdict: pass"

export const checkPassed = (report: string): boolean =>
  report.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) === passLine

const buildReportPrompt = (run: ReportRun): string =>
  [
    "The task sits in " + run.taskPath + ". The project's checkout sits at " + run.projectDir + ". " + kindAsks[run.kind],
    "This run ends in a report, not a commit or a PR. Write the report as markdown to " + reportPathOf(run.runDir) +
    ". When the report is written, print " + orcCompletionLine + " on its own line and stop."
  ].join("\n")

const runReportPi = (run: ReportRun): Effect.Effect<number | string, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const pi = yield* runPi(spawner, fs, path, run.exec, {
      agent: run.agent,
      prompt: buildReportPrompt(run),
      instructions: run.instructions,
      sessionDir: run.hostSessionsDir,
      resumeSession: null,
      logFile: run.runDir + "/agent.log",
      onSession: () => Effect.void
    }, run.pacing)
    return pi.end.kind === "exited" ? pi.end.exitCode : "orc stopped pi, idle for " + idleSpan(pi.end.idleSeconds) + " with no tool running"
  })

const outcomeOf = (run: ReportRun, report: { readonly path: string; readonly text: string } | null, piExit: number | string): ReportOutcome => {
  if (report !== null && run.kind === "parent" && !checkPassed(report.text)) {
    return { kind: "unreported", runId: run.runId, reason: "the final check did not end its report at " + report.path + " with " + passLine }
  }
  if (report !== null) {
    return { kind: "reported", runId: run.runId, report: report.path }
  }
  const pi = typeof piExit === "string" ? piExit : "pi exited " + piExit.toString()
  return { kind: "unreported", runId: run.runId, reason: pi + " and wrote no report at " + reportPathOf(run.runDir) }
}

export const runReport = (
  db: Database,
  run: ReportRun
): Effect.Effect<ReportOutcome, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* recordRun(db, {
      id: run.runId, project: run.projectDir, branch: run.branch, taskFile: run.taskPath, status: "running", started: run.started, sandbox: run.sandbox
    }).pipe(Effect.mapError((cause) => historyFailure("record the run in", cause)))
    const piExit = yield* runReportPi(run).pipe(Effect.catchTag("OrcRunError", (error) => Effect.succeed(error.message)))
    const written = yield* writtenReport(run.runDir)
    const fs = yield* FileSystem.FileSystem
    const report = written === null ? null : { path: written, text: yield* fs.readFileString(written).pipe(Effect.orElseSucceed(() => "")) }
    const outcome = outcomeOf(run, report, piExit)
    yield* updateRun(db, run.runId, {
      status: outcome.kind === "reported" ? "succeeded" : "failed",
      ended: new Date().toISOString(),
      prLink: null,
      endReason: outcome.kind === "reported" ? "Pi wrote " + outcome.report : outcome.reason
    }).pipe(Effect.mapError((cause) => historyFailure("record the run in", cause)))
    return outcome
  })

export const formatReportOutcome = (kind: ReportKind, outcome: ReportOutcome): string =>
  outcome.kind === "reported"
    ? "orc: " + kind + " run " + outcome.runId + " wrote its report to " + outcome.report
    : "orc: " + kind + " run " + outcome.runId + " failed: " + outcome.reason
