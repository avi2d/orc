import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { latestRunForBranchName, openQuestionsForRun, runsForBranch } from "../history-resume"
import type { OpenQuestion } from "../no-mistakes-gate"
import { formatHistoryError, openDatabase, stoppedEndReason, type RunRecord, RunStatusSchema } from "../run-history"
import { writtenReport } from "../report-run"
import { gateLogFileName } from "../no-mistakes"
import { Asking, askingFileName, AnswersFile, answersFileName, writeWhole } from "../answer-wait"
import type { QuestionAnswer } from "../no-mistakes-gate"
import { readJsonFileIfPresent } from "../json-file"
import { runDirFor, type TaskKind } from "../task-kind"
import { TaskId } from "./backlog"
import { orcGroup, PueueResult, PueueStatus } from "./pueue-status"
import { LabelArg } from "./token"
import { capture, type Command, decodeJson, readHeld, refuse, resolveProjectDir, RunnerError, type RunnerRequirements, taskBranch } from "./runner"

const RUNNER_JSON_SCHEMA = "orc.runner.v1" as const

const RunSummary = Schema.Struct({
  id: Schema.String,
  status: RunStatusSchema,
  prLink: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(Schema.String),
  openQuestions: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String, asked: Schema.optional(Schema.String) })),
  report: Schema.optional(Schema.String),
  asking: Schema.optional(Asking)
})
type RunSummary = typeof RunSummary.Type

const heldFields = {
  task: TaskId,
  pueueTask: Schema.Int,
  run: Schema.NullOr(RunSummary)
}

const RunnerResult = Schema.Union([
  Schema.Struct({ task: TaskId, status: Schema.Literal("unknown"), run: Schema.optional(RunSummary) }),
  Schema.Struct({ ...heldFields, status: Schema.Literals(["queued", "stashed"]) }),
  Schema.Struct({ ...heldFields, status: Schema.Literals(["running", "paused"]), started: Schema.String, outputAt: Schema.optional(Schema.String) }),
  Schema.Struct({ ...heldFields, status: Schema.Literal("succeeded"), started: Schema.String, ended: Schema.String }),
  Schema.Struct({ ...heldFields, status: Schema.Literal("failed"), started: Schema.String, ended: Schema.String, reason: Schema.String })
])
export type RunnerResult = typeof RunnerResult.Type

const RunnerDocument = Schema.Struct({ schema: Schema.Literal(RUNNER_JSON_SCHEMA), result: RunnerResult })

const failureReason = (result: typeof PueueResult.Type): string | null => {
  if (result === "Success") {
    return null
  }
  if (typeof result === "object") {
    return "Failed" in result ? "orc exited " + result.Failed : "pueue could not start it: " + result.FailedToSpawn
  }
  switch (result) {
    case "Killed": {
      return "the run was killed"
    }
    case "Errored": {
      return "pueue lost the run to an error"
    }
    case "DependencyFailed": {
      return "a task it waited on failed"
    }
  }
}

export type RunEnding =
  | { readonly kind: "close"; readonly outcome: "done" | "failed" | "stopped"; readonly reason: string; readonly pr: string | null; readonly report: string | null }
  | { readonly kind: "park"; readonly questions: Arr.NonEmptyReadonlyArray<OpenQuestion> }

type FinishedResult = Extract<RunnerResult, { readonly status: "succeeded" | "failed" }>

const reportEnding = (result: FinishedResult): RunEnding => {
  const report = result.run?.report ?? null
  if (report !== null) {
    return { kind: "close", outcome: "done", reason: "the run wrote its report", pr: null, report }
  }
  const why = result.status === "failed" ? (result.run?.endReason ?? result.reason) : result.run?.endReason ?? "pueue task " + result.pueueTask + " succeeded"
  return { kind: "close", outcome: "failed", reason: "the run wrote no report: " + why, pr: null, report: null }
}

// The beat ends a started task from this, so its done and failed match what runner result reports.
export const endingFromResult = (result: RunnerResult, kind: TaskKind): RunEnding | null => {
  if (result.status === "unknown" && result.run?.status === "stopped") {
    return { kind: "close", outcome: "stopped", reason: result.run.endReason ?? stoppedEndReason, pr: result.run.prLink ?? null, report: null }
  }
  if ((result.status === "succeeded" || result.status === "failed") && result.run?.status === "stopped") {
    return { kind: "close", outcome: "stopped", reason: result.run.endReason ?? stoppedEndReason, pr: result.run.prLink ?? null, report: null }
  }
  if (kind !== "ship" && (result.status === "succeeded" || result.status === "failed")) {
    return reportEnding(result)
  }
  if (result.status === "succeeded") {
    return { kind: "close", outcome: "done", reason: "pueue task " + result.pueueTask + " succeeded", pr: result.run?.prLink ?? null, report: null }
  }
  if (result.status !== "failed") {
    return null
  }
  const questions = result.run?.openQuestions ?? []
  return Arr.isReadonlyArrayNonEmpty(questions)
    ? { kind: "park", questions }
    : { kind: "close", outcome: "failed", reason: result.run?.endReason ?? result.reason, pr: result.run?.prLink ?? null, report: null }
}

interface PueueInterval {
  readonly start: string
  readonly end: string | null
}

const pueueIntervalOf = (status: PueueStatus): PueueInterval | null => {
  if ("Done" in status) {
    return { start: status.Done.start, end: status.Done.end }
  }
  if ("Running" in status) {
    return { start: status.Running.start, end: null }
  }
  if ("Paused" in status) {
    return { start: status.Paused.start, end: null }
  }
  return null
}

const startsWithin = (runStarted: string, interval: PueueInterval): boolean => {
  const runMs = Date.parse(runStarted)
  const startMs = Date.parse(interval.start)
  if (Number.isNaN(runMs) || Number.isNaN(startMs)) {
    return false
  }
  if (runMs < startMs) {
    return false
  }
  if (interval.end === null) {
    return true
  }
  const endMs = Date.parse(interval.end)
  if (Number.isNaN(endMs)) {
    return false
  }
  return runMs <= endMs
}

const assessHeld = (
  task: string,
  pueueTask: number,
  status: PueueStatus,
  run: RunSummary | null
): RunnerResult => {
  const held = { task, pueueTask, run }
  if ("Done" in status) {
    const { start, end, result } = status.Done
    const reason = failureReason(result)
    return reason === null
      ? { ...held, status: "succeeded", started: start, ended: end }
      : { ...held, status: "failed", started: start, ended: end, reason }
  }
  if ("Running" in status) {
    return { ...held, status: "running", started: status.Running.start }
  }
  if ("Paused" in status) {
    return { ...held, status: "paused", started: status.Paused.start }
  }
  return { ...held, status: "Stashed" in status ? "stashed" : "queued" }
}

const toSummary = (run: RunRecord, openQuestions: ReadonlyArray<OpenQuestion>, report: string | null, asking: typeof Asking.Type | null): RunSummary => ({
  id: run.id,
  status: run.status,
  prLink: run.prLink,
  endReason: run.endReason,
  openQuestions,
  ...(report === null ? {} : { report }),
  ...(asking === null ? {} : { asking })
})

const askingOf = (run: RunRecord, home: string): Effect.Effect<typeof Asking.Type | null, never, FileSystem.FileSystem> =>
  run.status === "running"
    ? readJsonFileIfPresent(runDirFor(home, run.id) + "/" + askingFileName, Asking).pipe(Effect.orElseSucceed(() => null))
    : Effect.succeed(null)

const readRun = (home: string, checkout: string, task: string, interval: PueueInterval | null): Effect.Effect<RunSummary | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const project = yield* resolveProjectDir(checkout)
    return yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) =>
        Effect.gen(function*() {
          const runs = yield* runsForBranch(db, project, taskBranch(task))
          const run = runs.find((candidate) => interval === null || startsWithin(candidate.started, interval)) ?? null
          return run === null
            ? null
            : toSummary(run, yield* openQuestionsForRun(db, run.id), yield* writtenReport(runDirFor(home, run.id)), yield* askingOf(run, home))
        }),
      (db) => Effect.sync(() => db.close())
    )
  }).pipe(
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: "cannot read the run history: " + formatHistoryError(error) }))
  )

const runLogAt = (home: string, runId: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = runDirFor(home, runId)
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    let latest: string | null = null
    for (const name of names) {
      if (name !== "agent.log" && name !== gateLogFileName && !/^fix-.*\.log$/.test(name) && !/^checks-.*\.txt$/.test(name)) {
        continue
      }
      const info = yield* fs.stat(dir + "/" + name).pipe(Effect.orElseSucceed(() => null))
      const at = info === null ? null : Option.match(info.mtime, { onNone: () => null, onSome: (mtime) => mtime.toISOString() })
      if (at !== null && (latest === null || Date.parse(at) > Date.parse(latest))) {
        latest = at
      }
    }
    return latest
  })

const readStoppedRun = (home: string, task: string): Effect.Effect<RunSummary | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    return yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) =>
        Effect.gen(function*() {
          const latest = yield* latestRunForBranchName(db, taskBranch(task))
          if (latest === null || latest.status !== "stopped") {
            return null
          }
          return toSummary(latest, yield* openQuestionsForRun(db, latest.id), yield* writtenReport(runDirFor(home, latest.id)), null)
        }),
      (db) => Effect.sync(() => db.close())
    )
  }).pipe(
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: "cannot read the run history: " + formatHistoryError(error) }))
  )

export const readResult = (task: string, home: string, label?: string | null): Effect.Effect<RunnerResult, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const held = yield* readHeld(home, task, label)
    if (held === null) {
      const stopped = yield* readStoppedRun(home, task)
      return stopped === null
        ? { task, status: "unknown" } satisfies RunnerResult
        : { task, status: "unknown", run: stopped } satisfies RunnerResult
    }
    const status = yield* Schema.decodeUnknownEffect(PueueStatus)(held.status).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "pueue reports a status orc cannot read for task " + held.id + ": " + error.message }))
    )
    const run = yield* readRun(home, held.path, task, pueueIntervalOf(status))
    const result = assessHeld(task, held.id, status, run)
    if (result.status !== "running" && result.status !== "paused") {
      return result
    }
    const runAt = run === null ? null : yield* runLogAt(home, run.id)
    return { ...result, status: run?.asking === undefined ? result.status : "paused", outputAt: runAt ?? result.started }
  })

const AnswerStdin = Schema.Struct({ ...AnswersFile.fields, label: Schema.optional(LabelArg) })

export interface Relay {
  readonly asking: string
  readonly answers: ReadonlyArray<QuestionAnswer>
}

const relayInto = (home: string, task: string, label: string | null, relay: Relay): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const result = yield* readResult(task, home, label)
    const run = result.status === "unknown" ? null : result.run
    if (run === null || run.asking === undefined) {
      return yield* refuse("no run of " + task + " waits for an answer")
    }
    if (run.asking.asked !== relay.asking) {
      return yield* refuse("run " + run.id + " of " + task + " no longer waits on the asking of " + relay.asking + ", it waits on the asking of " + run.asking.asked)
    }
    const file = runDirFor(home, run.id) + "/" + answersFileName
    if (!(yield* writeWhole(file, JSON.stringify({ asking: relay.asking, answers: relay.answers })))) {
      return yield* refuse("cannot write " + file)
    }
    return "handed " + relay.answers.map((entry) => entry.question).join(", ") + " to run " + run.id + " of " + task
  })

export const relayAnswers = (home: string, task: string, stdin: Effect.Effect<string, RunnerError>): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  stdin.pipe(
    Effect.flatMap((text) => decodeJson(text, AnswerStdin, "the answers on stdin")),
    Effect.flatMap((request) => relayInto(home, task, request.label ?? null, request))
  )

// The answers travel on stdin, so a reach that joins its argv for a remote shell cannot split the captain's words.
export const relayAnswersThrough = (
  command: Command,
  task: string,
  label: string | null,
  relay: Relay
): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture([...command, "runner", "answer", task], JSON.stringify({ ...(label === null ? {} : { label }), asking: relay.asking, answers: relay.answers })).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : refuse(command.join(" ") + " runner answer exited " + result.exitCode + ": " + result.stderr.trim())
    )
  )

const ResultStdin = Schema.Struct({ label: LabelArg })

// The label travels on stdin like a queue or renew request, so a reach that joins its argv for a remote shell cannot split it.
export const readStdinLabel = (stdin: Effect.Effect<string, RunnerError>): Effect.Effect<string | null, RunnerError> =>
  stdin.pipe(
    Effect.flatMap((text) =>
      text.trim() === ""
        ? Effect.succeed(null)
        : decodeJson(text, ResultStdin, "the result request on stdin").pipe(Effect.map(({ label }) => label))
    )
  )

export const readResultThrough = (command: Command, task: string, label?: string | null): Effect.Effect<RunnerResult, RunnerError, ChildProcessSpawner.ChildProcessSpawner> => {
  const stdin = label == null ? null : JSON.stringify({ label })
  return capture([...command, "runner", "result", task, "--json", ...(stdin === null ? [] : ["--stdin-label"])], stdin).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? decodeJson(result.stdout, RunnerDocument, command.join(" ") + " runner result")
        : refuse(command.join(" ") + " runner result exited " + result.exitCode + ": " + result.stderr.trim())
    ),
    Effect.map((document) => document.result)
  )
}

export const killHeldThrough = (command: Command, task: string, label?: string | null): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> => {
  const stdin = label == null ? null : JSON.stringify({ label })
  return capture([...command, "runner", "kill", task, ...(stdin === null ? [] : ["--stdin-label"])], stdin).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : refuse(command.join(" ") + " runner kill exited " + result.exitCode + ": " + result.stderr.trim())
    )
  )
}

export const runnerJson = (result: RunnerResult): typeof RunnerDocument.Type => ({ schema: RUNNER_JSON_SCHEMA, result })

const headLine = (result: RunnerResult): string => {
  switch (result.status) {
    case "unknown": {
      return result.task + ": no pueue task in group " + orcGroup + " holds it"
    }
    case "queued":
    case "stashed": {
      return result.task + ": " + result.status + " as pueue task " + result.pueueTask
    }
    case "running":
    case "paused": {
      return result.task + ": " + result.status + " as pueue task " + result.pueueTask + " since " + result.started +
        (result.outputAt === undefined ? "" : ", output last written " + result.outputAt)
    }
    case "succeeded": {
      return result.task + ": succeeded as pueue task " + result.pueueTask + ", " + result.started + " to " + result.ended
    }
    case "failed": {
      return result.task + ": failed as pueue task " + result.pueueTask + ", " + result.started + " to " + result.ended + ": " + result.reason
    }
  }
}

const runLine = (task: string, run: RunSummary | null): string =>
  run === null
    ? "orc holds no run on " + taskBranch(task)
    : "orc run " + run.id + " " + run.status + (run.prLink === null ? "" : ", PR " + run.prLink) + (run.report === undefined ? "" : ", report " + run.report) +
      (run.endReason === null ? "" : ": " + run.endReason) +
      (run.asking === undefined ? "" : ", waiting until " + run.asking.until + " for the captain's answer to " + run.asking.questions.map((question) => question.id).join(", "))

export const formatResult = (result: RunnerResult): string => {
  if (result.status === "unknown") {
    return headLine(result)
  }
  return [headLine(result), runLine(result.task, result.run)].join("\n")
}
