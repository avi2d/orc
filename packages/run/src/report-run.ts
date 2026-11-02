import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "./agents"
import type { SandboxKind } from "./args"
import { historyFailure } from "./history-write"
import { noSandboxEnv } from "./no-sandbox"
import { orcCompletionLine, piWithTools } from "./pi"
import { recordRun, updateRun } from "./run-history"
import { describeCause, OrcRunError } from "./run-session"
import { agentReportFileName, type ReportKind } from "./task-kind"

export interface ReportRun {
  readonly kind: ReportKind
  readonly runId: string
  readonly runDir: string
  readonly projectDir: string
  readonly branch: string
  readonly sandbox: SandboxKind
  readonly taskPath: string
  readonly piSessionDir: string
  readonly hostSessionsDir: string
  readonly piAgentDir: string | undefined
  readonly agent: AgentFile
  readonly started: string
  readonly env: Readonly<Record<string, string | undefined>>
}

export type ReportOutcome =
  | { readonly kind: "reported"; readonly runId: string; readonly report: string }
  | { readonly kind: "unreported"; readonly runId: string; readonly reason: string }

const reportPathOf = (runDir: string): string => runDir + "/" + agentReportFileName

const kindAsk = (run: ReportRun): string =>
  run.kind === "scout"
    ? "Read the checkout and change nothing in it."
    : "Do what it asks; when it asks for evidence, put that evidence in the report."

const buildReportPrompt = (run: ReportRun): string =>
  [
    "The task sits in " + run.taskPath + ". The project's checkout sits at " + run.projectDir + ". " + kindAsk(run),
    "This run ends in a report, not a commit or a PR. Write the report as markdown to " + reportPathOf(run.runDir) +
    ". When the report is written, print " + orcCompletionLine + " on its own line and stop."
  ].join("\n")

const definedEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]))

const runPi = (run: ReportRun): Effect.Effect<number, OrcRunError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const print = piWithTools(run.agent, { hostSessionsDir: run.hostSessionsDir, sandboxSessionsDir: run.hostSessionsDir })
      .buildPrintCommand({ prompt: buildReportPrompt(run), dangerouslySkipPermissions: true })
    const dirs = { piSessionDir: run.piSessionDir, hostSessionsDir: run.hostSessionsDir, piAgentDir: run.piAgentDir }
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", print.command], {
      cwd: run.runDir,
      env: { ...definedEnv(run.env), ...noSandboxEnv(dirs) },
      extendEnv: false,
      stdin: print.stdin === undefined ? "ignore" : Stream.fromIterable([new TextEncoder().encode(print.stdin)])
    }))
    const [log, errors, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    yield* fs.writeFileString(run.runDir + "/agent.log", log + errors).pipe(Effect.orElseSucceed(() => undefined))
    return exitCode
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: pi did not run: " + describeCause(cause) }))
  )

export const writtenReport = (runDir: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = reportPathOf(runDir)
    const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null))
    return info?.type === "File" ? file : null
  })

const outcomeOf = (run: ReportRun, report: string | null, piExit: number | string): ReportOutcome => {
  if (report !== null) {
    return { kind: "reported", runId: run.runId, report }
  }
  const pi = typeof piExit === "string" ? piExit : "pi exited " + piExit.toString()
  return { kind: "unreported", runId: run.runId, reason: pi + " and wrote no report at " + reportPathOf(run.runDir) }
}

export const runReport = (
  db: Database,
  run: ReportRun
): Effect.Effect<ReportOutcome, OrcRunError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* recordRun(db, {
      id: run.runId, project: run.projectDir, branch: run.branch, taskFile: run.taskPath, status: "running", started: run.started, sandbox: run.sandbox
    }).pipe(Effect.mapError((cause) => historyFailure("record the run in", cause)))
    const piExit = yield* runPi(run).pipe(Effect.catchTag("OrcRunError", (error) => Effect.succeed(error.message)))
    const outcome = outcomeOf(run, yield* writtenReport(run.runDir), piExit)
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
