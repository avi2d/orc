import type { PiTokenUse } from "./pi"
import type { NoMistakesFinding, NoMistakesRecord } from "./no-mistakes"
import { toFileUrl } from "./run-history"

export const reportFileName = "report.md"

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
  readonly prLink: string | null
  readonly noMistakes: NoMistakesRecord | null
  readonly endReason: string
}

export const findingLine = (finding: NoMistakesFinding): string =>
  [finding.id, finding.severity, finding.file + (finding.line === "" ? "" : ":" + finding.line), finding.action, finding.description].filter((part) => part !== "").join(" ")

export const measuredSignals = (report: Pick<OrcRunReport, "tokens" | "commits">): ReadonlyArray<{ readonly name: string; readonly value: string }> => [
  ...(report.tokens === null ? [] : [
    { name: "input-tokens", value: report.tokens.input.toString() },
    { name: "output-tokens", value: report.tokens.output.toString() }
  ]),
  ...(report.commits === null ? [] : [{ name: "commit-count", value: report.commits.length.toString() }])
]

export const noMistakesSignals = (record: NoMistakesRecord): ReadonlyArray<{ readonly name: string; readonly value: string }> => [
  { name: "finding-count", value: record.findings.length.toString() },
  { name: "result", value: record.status },
  { name: "gates-answered", value: record.gatesAnswered.toString() },
  ...(record.gate === null ? [] : [{ name: "gate", value: record.gate }]),
  ...(record.prLink === null ? [] : [{ name: "pr-link", value: record.prLink }]),
  ...(record.reviewer === null ? [] : [{ name: "reviewer", value: record.reviewer }])
]

type ChecksLoopStep =
  | { readonly kind: "checks"; readonly round: ChecksRoundSummary }
  | { readonly kind: "fix"; readonly fix: RecordedFixAttempt }

const checksLoopSteps = (report: OrcRunReport): ReadonlyArray<ChecksLoopStep> =>
  (report.checksRounds ?? []).flatMap((round): ReadonlyArray<ChecksLoopStep> => {
    const fix = report.fixes.find((attempt) => attempt.attempt === round.round)
    return fix === undefined ? [{ kind: "checks", round }] : [{ kind: "checks", round }, { kind: "fix", fix }]
  })

const stepLines = (report: OrcRunReport): Array<string> => {
  const lines = ["- implement: " + (report.implementPassed ? "passed" : "failed")]
  for (const step of checksLoopSteps(report)) {
    lines.push(step.kind === "checks"
      ? checksLine(step.round.round, step.round.passed, step.round.failed, step.round.file)
      : "- fix " + step.fix.attempt.toString() + ": " + step.fix.status + " " + toFileUrl(step.fix.evidenceIn))
  }
  if (report.noMistakes !== null) {
    lines.push(noMistakesLine(report.noMistakes.status, report.noMistakes.gate))
  }
  return lines
}

const checksLine = (round: number, passed: boolean, failed: ReadonlyArray<string>, file: string): string => {
  const outcome = passed ? "passed" : "failed (" + failed.join(", ") + ")"
  return "- checks round " + round.toString() + ": " + outcome + " " + toFileUrl(file)
}

const noMistakesLine = (status: string, gate: string | null): string =>
  "- no-mistakes: " + status + (gate === null ? "" : " at " + gate)

const evidenceLines = (taskFileUrl: string, report: OrcRunReport): Array<string> => {
  const lines = [
    "- task: " + taskFileUrl,
    "- implement: " + toFileUrl(report.runDir + "/implement-1.md")
  ]
  for (const round of report.checksRounds ?? []) {
    lines.push("- checks round " + round.round.toString() + ": " + toFileUrl(round.file))
  }
  if (report.noMistakes !== null) {
    lines.push("- no-mistakes: " + toFileUrl(report.runDir + "/no-mistakes.txt"))
  }
  if (report.sessionFile !== null) {
    lines.push("- session: " + toFileUrl(report.sessionFile))
  }
  return lines
}

const signalEntries = (report: OrcRunReport): Array<{ readonly name: string; readonly value: string }> => {
  const entries: Array<{ readonly name: string; readonly value: string }> = [...measuredSignals(report)]
  for (const round of report.checksRounds ?? []) {
    for (const check of round.checks) {
      entries.push({ name: "check " + check.name + " round " + round.round.toString(), value: check.passed ? "passed" : "failed" })
    }
  }
  if (report.noMistakes !== null) {
    entries.push(...noMistakesSignals(report.noMistakes))
  }
  return entries
}

const headLines = (taskText: string, taskFileUrl: string, reportUrl: string, report: OrcRunReport): Array<string> => {
  const lines: Array<string> = ["# Run report " + report.runId, ""]
  lines.push("Task: " + taskFileUrl)
  if (taskText !== "") {
    lines.push("")
    lines.push(taskText.trimEnd())
  }
  lines.push("")
  lines.push("Branch: " + report.branch)
  lines.push("Status: " + runStatus(report))
  lines.push("PR: " + (report.prLink ?? "none"))
  lines.push("Report: " + reportUrl)
  lines.push("")
  lines.push("## Steps")
  lines.push("")
  lines.push(...stepLines(report))
  lines.push("")
  lines.push("## Evidence")
  lines.push("")
  lines.push(...evidenceLines(taskFileUrl, report))
  return lines
}

const tailLines = (report: OrcRunReport): Array<string> => {
  const lines: Array<string> = ["", "## Signals", ""]
  const entries = signalEntries(report)
  if (entries.length === 0) {
    lines.push("- none")
  }
  for (const entry of entries) {
    lines.push("- " + entry.name + ": " + entry.value)
  }
  lines.push("")
  if (report.noMistakes !== null && report.noMistakes.findings.length > 0) {
    lines.push("## Findings")
    lines.push("")
    for (const finding of report.noMistakes.findings) {
      lines.push("- " + findingLine(finding))
    }
    lines.push("")
  }
  lines.push("## Result")
  lines.push("")
  lines.push(report.endReason)
  return lines
}

export const reportMarkdown = (taskText: string, taskFileUrl: string, reportUrl: string, report: OrcRunReport): string =>
  [...headLines(taskText, taskFileUrl, reportUrl, report), ...tailLines(report)].join("\n") + "\n"

export const runStatus = (report: OrcRunReport): string => {
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
