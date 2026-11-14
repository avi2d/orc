import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentExec } from "../../shared/sandbox/index"
import type { AgentFile } from "../../entities/agent/index"
import type { SandboxKind } from "../../shared/sandbox/index"
import { orcCompletionLine } from "../../entities/agent/index"
import { failingFileName, idleSpan, type PiPacing, runPi } from "../../entities/agent/index"
import { askOnLoop, loopContinuePrompt, loopingNote } from "./loop-pause"
import { historyFailure, recordRun, recordStep, updateRun, updateStep } from "../../entities/run-history/index"
import type { OrcRunError } from "../../shared/lib/index"
import { reportPathOf, writtenReport } from "../../entities/run-history/index"
import { taskOfBranch, type ReportKind } from "../../entities/backlog/index"

export interface ReportRun {
  readonly kind: ReportKind
  readonly runId: string
  readonly runDir: string
  readonly projectDir: string
  readonly branch: string
  readonly machine: string | null
  readonly sandbox: SandboxKind
  readonly taskPath: string
  readonly instructions: string | null
  readonly hostSessionsDir: string
  readonly agent: AgentFile
  readonly started: string
  readonly exec: AgentExec
  readonly pacing: PiPacing
  readonly answerWaitSeconds: number
}

export type ReportOutcome =
  | { readonly kind: "reported"; readonly runId: string; readonly report: string }
  | { readonly kind: "stopped"; readonly runId: string; readonly reason: string }
  | { readonly kind: "unreported"; readonly runId: string; readonly reason: string }

type ReportPiEnd =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "ended"; readonly reason: string }
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "unanswered"; readonly reason: string }

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

const runReportPi = (run: ReportRun): Effect.Effect<ReportPiEnd, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    let next: { readonly prompt: string; readonly resumeSession: string | null } = { prompt: buildReportPrompt(run), resumeSession: null }
    for (;;) {
      const pi = yield* runPi(spawner, fs, path, run.exec, {
        agent: run.agent,
        prompt: next.prompt,
        instructions: run.instructions,
        sessionDir: run.hostSessionsDir,
        resumeSession: next.resumeSession,
        logFile: run.runDir + "/agent.log",
        failingFile: run.runDir + "/" + failingFileName,
        onSession: () => Effect.void
      }, run.pacing)
      if (pi.end.kind === "exited") {
        return { kind: "exited", code: pi.end.exitCode }
      }
      if (pi.end.kind === "idle") {
        return { kind: "ended", reason: "orc stopped pi, idle for " + idleSpan(pi.end.idleSeconds) + " with no tool running" }
      }
      const verdict = yield* askOnLoop(run.runDir, run.answerWaitSeconds, pi.end)
      if (verdict.kind === "stop") {
        return { kind: "stop", reason: verdict.reason }
      }
      if (verdict.kind === "unanswered") {
        return { kind: "unanswered", reason: loopingNote(pi.end) }
      }
      next = { prompt: loopContinuePrompt(verdict.words), resumeSession: pi.sessionFile ?? next.resumeSession }
    }
  })

const outcomeOf = (run: ReportRun, report: { readonly path: string; readonly text: string } | null, piEnd: ReportPiEnd): ReportOutcome => {
  if (piEnd.kind === "stop") {
    return { kind: "stopped", runId: run.runId, reason: report === null ? piEnd.reason : piEnd.reason + " and left a partial report at " + report.path }
  }
  if (piEnd.kind === "unanswered") {
    return { kind: "unreported", runId: run.runId, reason: report === null ? piEnd.reason + " and wrote no report at " + reportPathOf(run.runDir) : piEnd.reason + " and left a partial report at " + report.path }
  }
  if (report !== null && run.kind === "parent" && !checkPassed(report.text)) {
    return { kind: "unreported", runId: run.runId, reason: "the final check did not end its report at " + report.path + " with " + passLine }
  }
  if (report !== null) {
    return { kind: "reported", runId: run.runId, report: report.path }
  }
  const pi = piEnd.kind === "exited" ? "pi exited " + piEnd.code.toString() : piEnd.reason
  return { kind: "unreported", runId: run.runId, reason: pi + " and wrote no report at " + reportPathOf(run.runDir) }
}

export const runReport = (
  db: Database,
  run: ReportRun
): Effect.Effect<ReportOutcome, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* recordRun(db, {
      id: run.runId, project: run.projectDir, branch: run.branch, taskFile: run.taskPath, status: "running", started: run.started, sandbox: run.sandbox,
      kind: run.kind, delivery: null, task: taskOfBranch(run.branch), machine: run.machine, worktree: run.projectDir
    }).pipe(Effect.mapError((cause) => historyFailure("record the run in", cause)))
    yield* recordStep(db, { runId: run.runId, name: "implement", attempt: 1, status: "running", started: run.started, agentFile: run.agent.path, piSessionFile: null, model: run.agent.model, thinking: run.agent.thinking }).pipe(Effect.asVoid, Effect.mapError((cause) => historyFailure("record the step in", cause)))
    const piEnd = yield* runReportPi(run).pipe(Effect.catchTag("OrcRunError", (error) => Effect.succeed({ kind: "ended", reason: error.message } as const)))
    const written = yield* writtenReport(run.runDir)
    const fs = yield* FileSystem.FileSystem
    const report = written === null ? null : { path: written, text: yield* fs.readFileString(written).pipe(Effect.orElseSucceed(() => "")) }
    const outcome = outcomeOf(run, report, piEnd)
    yield* updateStep(db, run.runId, "implement", 1, { status: outcome.kind === "reported" ? "passed" : "failed", ended: new Date().toISOString() }).pipe(Effect.asVoid, Effect.mapError((cause) => historyFailure("record the step in", cause)))
    yield* updateRun(db, run.runId, {
      status: outcome.kind === "reported" ? "succeeded" : outcome.kind === "stopped" ? "stopped" : "failed",
      ended: new Date().toISOString(),
      prLink: null,
      endReason: outcome.kind === "reported" ? "Pi wrote " + outcome.report : outcome.reason
    }).pipe(Effect.mapError((cause) => historyFailure("record the run in", cause)))
    return outcome
  })

export const formatReportOutcome = (kind: ReportKind, outcome: ReportOutcome): string =>
  outcome.kind === "reported"
    ? "orc: " + kind + " run " + outcome.runId + " wrote its report to " + outcome.report
    : outcome.kind === "stopped"
      ? "orc: " + kind + " run " + outcome.runId + " stopped: " + outcome.reason
      : "orc: " + kind + " run " + outcome.runId + " failed: " + outcome.reason
