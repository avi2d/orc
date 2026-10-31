import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { latestRunForBranch } from "../history-resume"
import { formatHistoryError, openDatabase, RunStatusSchema } from "../run-history"
import { TaskId } from "./backlog"
import { orcGroup, PueueResult, PueueStatus } from "./pueue-status"
import { LabelArg } from "./token"
import { capture, type Command, decodeJson, readHeld, refuse, resolveProjectDir, RunnerError, type RunnerRequirements, taskBranch } from "./runner"

const RUNNER_JSON_SCHEMA = "orc.runner.v1" as const

const RunSummary = Schema.Struct({
  id: Schema.String,
  status: RunStatusSchema,
  prLink: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(Schema.String)
})
type RunSummary = typeof RunSummary.Type

const heldFields = {
  task: TaskId,
  pueueTask: Schema.Int,
  run: Schema.NullOr(RunSummary)
}

const RunnerResult = Schema.Union([
  Schema.Struct({ task: TaskId, status: Schema.Literal("unknown") }),
  Schema.Struct({ ...heldFields, status: Schema.Literals(["queued", "stashed"]) }),
  Schema.Struct({ ...heldFields, status: Schema.Literals(["running", "paused"]), started: Schema.String }),
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

export interface TaskClosing {
  readonly outcome: "done" | "failed"
  readonly reason: string
}

export const closingFromResult = (result: RunnerResult): TaskClosing | null => {
  if (result.status === "succeeded") {
    return { outcome: "done", reason: "pueue task " + result.pueueTask + " succeeded" }
  }
  if (result.status === "failed") {
    return { outcome: "failed", reason: result.reason }
  }
  return null
}

const closingOf = (pueueTask: number, status: PueueStatus): TaskClosing | null => {
  if (!("Done" in status)) {
    return null
  }
  const reason = failureReason(status.Done.result)
  return reason === null
    ? { outcome: "done", reason: "pueue task " + pueueTask + " succeeded" }
    : { outcome: "failed", reason }
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

const readRun = (home: string, checkout: string, task: string): Effect.Effect<RunSummary | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const project = yield* resolveProjectDir(checkout)
    const run = yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) => latestRunForBranch(db, project, taskBranch(task)),
      (db) => Effect.sync(() => db.close())
    )
    return run === null ? null : { id: run.id, status: run.status, prLink: run.prLink, endReason: run.endReason }
  }).pipe(
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: "cannot read the run history: " + formatHistoryError(error) }))
  )

// The beat closes a started task from this, so its done and failed match what runner result reports.
export const readClosing = (task: string, home: string, label?: string | null): Effect.Effect<TaskClosing | null, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const held = yield* readHeld(home, task, label)
    if (held === null) {
      return null
    }
    const status = yield* Schema.decodeUnknownEffect(PueueStatus)(held.status).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "pueue reports a status orc cannot read for task " + held.id + ": " + error.message }))
    )
    return closingOf(held.id, status)
  })

export const readResult = (task: string, home: string, label?: string | null): Effect.Effect<RunnerResult, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const held = yield* readHeld(home, task, label)
    if (held === null) {
      return { task, status: "unknown" } satisfies RunnerResult
    }
    const status = yield* Schema.decodeUnknownEffect(PueueStatus)(held.status).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "pueue reports a status orc cannot read for task " + held.id + ": " + error.message }))
    )
    const run = yield* readRun(home, held.path, task)
    return assessHeld(task, held.id, status, run)
  })

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
      return result.task + ": " + result.status + " as pueue task " + result.pueueTask + " since " + result.started
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
    : "orc run " + run.id + " " + run.status + (run.prLink === null ? "" : ", PR " + run.prLink) + (run.endReason === null ? "" : ": " + run.endReason)

export const formatResult = (result: RunnerResult): string => {
  if (result.status === "unknown") {
    return headLine(result)
  }
  return [headLine(result), runLine(result.task, result.run)].join("\n")
}
