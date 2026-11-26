import { Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { AgentFile, AskSetup } from "../../entities/agent/index"
import type { SandboxKind } from "../../shared/sandbox/index"
import { orcCompletionLine } from "../../entities/agent/index"
import type { AllowWord, NoMistakesRecord, NoMistakesRunner, QuestionAnswer } from "../../entities/review-gate/index"
import { OrcRunError } from "../../shared/lib/index"
import { toFileUrl } from "../../entities/run-history/index"
import { findingLine, reportFileName, reportMarkdown, runStatus, type OrcRunCommit, type OrcRunReport } from "../../entities/run-history/index"
import { handoverFileName, handoverNote, lastAssistantReply, longSessionWarning } from "../../entities/agent/index"
import { branchCommits } from "../../shared/process/index"
import { readFailure } from "../../shared/config/index"
import type { PullRequestOpener } from "../../entities/pull-request/index"

export type { ChecksRoundSummary, OrcRunCommit, OrcRunReport, RecordedFixAttempt } from "../../entities/run-history/index"

export type RunDeliverer =
  | { readonly kind: "no-mistakes"; readonly runner: NoMistakesRunner }
  | { readonly kind: "direct-PR"; readonly opener: PullRequestOpener; readonly reviewer: AgentFile }
  | { readonly kind: "orc"; readonly opener: PullRequestOpener; readonly reviewer: AgentFile }

export const prBodyFileName = "pr-body.md"

export interface HistoryRun {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly git: string
  readonly projectDir: string
  readonly runId: string
  readonly resumeRun?: string | undefined
  readonly runDir: string
  readonly piSessionDir: string
  readonly hostSessionsDir: string
  readonly taskPath: string
  readonly instructions: string | null
  readonly agent: AgentFile
  readonly fixer: AgentFile
  readonly asks: AskSetup
  readonly branch: string
  readonly sandbox: SandboxKind
  readonly started: string
  readonly worktreeDir: string
  readonly machine: string | null
  readonly delivery: RunDeliverer
  readonly allow?: ReadonlyArray<AllowWord> | undefined
  readonly answers?: ReadonlyArray<QuestionAnswer> | undefined
  readonly answerWaitSeconds?: number | undefined
}

const commitsText = (commits: OrcRunReport["commits"]): string =>
  commits === null ? "unknown" : commits.length.toString() + commits.map((commit) => " " + commit.sha).join(",")

const inputTokensText = (tokens: OrcRunReport["tokens"]): string =>
  tokens === null ? "unknown" : tokens.input.toString()

const outputTokensText = (tokens: OrcRunReport["tokens"]): string =>
  tokens === null ? "unknown" : tokens.output.toString()

const sessionSizeText = (sessionSize: OrcRunReport["sessionSize"]): string =>
  sessionSize === null ? "unknown" : sessionSize.turns.toString() + " turns, " + sessionSize.compactions.toString() + " compactions"

const longSessionText = (sessionSize: OrcRunReport["sessionSize"]): string =>
  sessionSize === null ? "unknown" : (longSessionWarning(sessionSize) ?? "no")

const handoverText = (report: OrcRunReport): string =>
  report.sessionSize !== null && longSessionWarning(report.sessionSize) !== null ? toFileUrl(report.runDir + "/" + handoverFileName) : "none"

const checksText = (checksRounds: OrcRunReport["checksRounds"], fixAttempts: number): string => {
  if (checksRounds === null) {
    return "never ran"
  }
  if (checksRounds.every((round) => round.checks.length === 0)) {
    return "no local checks run"
  }
  return checksRounds.length.toString() + (checksRounds.length === 1 ? " round" : " rounds") + ", " + fixAttempts.toString() + (fixAttempts === 1 ? " fix attempt" : " fix attempts")
}

export const formatReport = (report: OrcRunReport): string =>
  [
    "run id: " + report.runId,
    "run folder: " + toFileUrl(report.runDir),
    "report: " + toFileUrl(report.runDir + "/" + reportFileName),
    "branch: " + report.branch,
    "agent file: " + toFileUrl(report.agentPath) + " (" + report.agentSource + ")",
    "model: " + report.model,
    "pi session: " + (report.sessionId ?? "none"),
    "session file: " + (report.sessionFile === null ? "none" : toFileUrl(report.sessionFile)),
    "commits: " + commitsText(report.commits),
    "input tokens: " + inputTokensText(report.tokens),
    "output tokens: " + outputTokensText(report.tokens),
    "session size: " + sessionSizeText(report.sessionSize),
    "long session: " + longSessionText(report.sessionSize),
    "handover: " + handoverText(report),
    "checks: " + checksText(report.checksRounds, report.fixAttempts),
    "pr: " + (report.prLink ?? "none"),
    "no-mistakes: " + (report.noMistakes === null ? "never ran" : noMistakesSummary(report.noMistakes)),
    "status: " + runStatus(report),
    report.endReason
  ].join("\n")

const noMistakesSummary = (record: NoMistakesRecord): string =>
  record.status + ", " + record.findings.length.toString() + (record.findings.length === 1 ? " finding" : " findings") + ", " +
  record.gatesAnswered.toString() + (record.gatesAnswered === 1 ? " gate answered" : " gates answered") + ", " +
  (record.reviewer === null ? "reviewer not named" : "reviewed by " + record.reviewer)

export const noMistakesFile = (run: HistoryRun): string => run.path.join(run.runDir, "no-mistakes.txt")

const noMistakesText = (record: NoMistakesRecord): string =>
  [
    "no-mistakes result: " + record.status,
    "PR: " + (record.prLink ?? "none"),
    "reviewer: " + (record.reviewer ?? "not named"),
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
  sessionSize: null,
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

const sessionEvidenceLine = (sessionId: string | null, sessionFile: string | null): string =>
  sessionId === null ? "Pi stored no session." : "Pi session " + sessionId + " is stored at " + (sessionFile ?? "an unknown path") + "."

const markerEvidenceLine = (markerVerified: boolean): string =>
  markerVerified ? "Pi printed " + orcCompletionLine + "." : "orc could not verify that Pi printed " + orcCompletionLine + "."

const commitsEvidenceLine = (commits: OrcRunReport["commits"], branch: string): string => {
  if (commits === null) {
    return "orc could not tell which commits Pi made on " + branch + "."
  }
  return commits.length === 0 ? "Pi made no commit on " + branch + "." : "Commits on " + branch + "."
}

const tokensEvidenceLine = (tokens: OrcRunReport["tokens"]): string =>
  tokens === null
    ? "Pi's token use is unknown."
    : "Pi consumed " + tokens.input.toString() + " input tokens and " + tokens.output.toString() + " output tokens."

const checksEvidenceLines = (checksRounds: OrcRunReport["checksRounds"], fixAttempts: number, basename: (file: string) => string): ReadonlyArray<string> => {
  if (checksRounds === null) {
    return []
  }
  const summary = checksRounds.every((round) => round.checks.length === 0)
    ? "No local checks ran."
    : "Checks ran " + checksRounds.length.toString() + (checksRounds.length === 1 ? " round" : " rounds") + " with " + fixAttempts.toString() + (fixAttempts === 1 ? " fix attempt" : " fix attempts") + "."
  return [summary, "Checks evidence: " + checksRounds.map((round) => basename(round.file)).join(", ") + "."]
}

export const writeEvidence = (run: HistoryRun, report: OrcRunReport): Effect.Effect<void, OrcRunError> => {
  const lines = [
    "Implement step for task " + run.taskPath + ".",
    "Agent file " + report.agentPath + " (" + report.agentSource + ") names model " + report.model + " with tools " + run.agent.tools.join(", ") + ".",
    sessionEvidenceLine(report.sessionId, report.sessionFile),
    markerEvidenceLine(report.markerVerified),
    commitsEvidenceLine(report.commits, run.branch),
    ...(report.commits ?? []).map((commit) => commit.sha + " " + commit.subject),
    tokensEvidenceLine(report.tokens),
    ...checksEvidenceLines(report.checksRounds, report.fixAttempts, (file) => run.path.basename(file)),
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

export const writeHandover = (run: HistoryRun, report: OrcRunReport): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    if (report.sessionSize === null || longSessionWarning(report.sessionSize) === null) {
      return null
    }
    const taskText = yield* run.fs.readFileString(run.taskPath).pipe(Effect.orElseSucceed(() => ""))
    const sessionJsonl = report.sessionFile === null
      ? null
      : yield* run.fs.readFileString(report.sessionFile).pipe(Effect.map((text) => text as string | null), Effect.orElseSucceed(() => null))
    const branch = yield* branchCommits(run.spawner, run.git, run.branch, run.projectDir).pipe(Effect.orElseSucceed(() => [] as Array<OrcRunCommit>))
    const seen = new Set((report.commits ?? []).map((commit) => commit.sha))
    const commits = [...(report.commits ?? []), ...branch.filter((commit) => !seen.has(commit.sha))]
    const file = run.path.join(run.runDir, handoverFileName)
    const note = handoverNote({
      runId: report.runId,
      branch: report.branch,
      counts: report.sessionSize,
      commits,
      taskText,
      lastReply: lastAssistantReply(sessionJsonl),
      endReason: report.endReason
    })
    yield* run.fs.writeFileString(file, note).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the handover note " + file + ": " + String(cause) }))
    )
    return file
  })

export const writeReport = (run: HistoryRun, report: OrcRunReport): Effect.Effect<void, OrcRunError> => {
  const file = run.path.join(run.runDir, reportFileName)
  return run.fs.readFileString(run.taskPath).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the task file for the report: " + readFailure(cause) })),
    Effect.flatMap((taskText) =>
      run.fs.writeFileString(file, reportMarkdown(taskText, toFileUrl(run.taskPath), toFileUrl(file), report)).pipe(
        Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the report file: " + String(cause) }))
      )
    )
  )
}
