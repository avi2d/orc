import { Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "./agents"
import { orcCompletionLine } from "./pi"
import type { NoMistakesRecord } from "./no-mistakes"
import { OrcRunError } from "./run-session"
import { toFileUrl } from "./run-history"
import { findingLine, reportFileName, reportMarkdown, type OrcRunReport } from "./report"

export type { ChecksRoundSummary, OrcRunCommit, OrcRunReport, RecordedFixAttempt } from "./report"

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
  readonly noMistakesPath: string
}

export const formatReport = (report: OrcRunReport): string =>
  [
    "run id: " + report.runId,
    "run folder: " + report.runDir,
    "report: " + toFileUrl(report.runDir + "/" + reportFileName),
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
    "pr: " + (report.prLink ?? "none"),
    "no-mistakes: " + (report.noMistakes === null ? "never ran" : noMistakesSummary(report.noMistakes)),
    "status: " + runStatus(report),
    report.endReason
  ].join("\n")

const runStatus = (report: OrcRunReport): string => {
  if (report.completed) {
    return "completed"
  }
  if (!report.markerVerified) {
    return "incomplete"
  }
  if ((report.commits ?? []).length === 0) {
    return "no commit"
  }
  const finalRound = report.checksRounds?.at(-1)
  if (finalRound === undefined || !finalRound.passed) {
    return "checks failed"
  }
  return "no-mistakes " + (report.noMistakes?.status ?? "never ran") + (report.prLink === null ? ", no PR" : ", PR open")
}

const noMistakesSummary = (record: NoMistakesRecord): string =>
  record.status + ", " + record.findings.length.toString() + (record.findings.length === 1 ? " finding" : " findings") + ", " +
  record.gatesAnswered.toString() + (record.gatesAnswered === 1 ? " gate answered" : " gates answered")

const noMistakesFile = (run: HistoryRun): string => run.path.join(run.runDir, "no-mistakes.txt")

const noMistakesText = (record: NoMistakesRecord): string =>
  [
    "no-mistakes result: " + record.status,
    "PR: " + (record.prLink ?? "none"),
    "findings: " + record.findings.length.toString(),
    "gates answered: " + record.gatesAnswered.toString(),
    ...record.findings.map(findingLine),
    record.result
  ].join("\n") + "\n"

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
  prLink: null,
  noMistakes: null,
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
  const implement = run.fs.writeFileString(run.path.join(run.runDir, "implement-1.md"), lines.join("\n") + "\n")
  const mistakes = report.noMistakes === null
    ? Effect.void
    : run.fs.writeFileString(noMistakesFile(run), noMistakesText(report.noMistakes))
  return implement.pipe(
    Effect.andThen(mistakes),
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the evidence file: " + String(cause) }))
  )
}

export const writeReport = (run: HistoryRun, report: OrcRunReport): Effect.Effect<void, OrcRunError> => {
  const file = run.path.join(run.runDir, reportFileName)
  return run.fs.readFileString(run.taskPath).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((taskText) =>
      run.fs.writeFileString(file, reportMarkdown(taskText, toFileUrl(run.taskPath), toFileUrl(file), report))
    ),
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the report file: " + String(cause) }))
  )
}
