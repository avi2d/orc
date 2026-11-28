import { Duration, Effect } from "effect"
import { runLabel, type TaskRecord } from "../../entities/backlog/index"
import { readRunResult, type RunnerRequirements, type RunnerResult } from "../../features/queueing-a-task/index"
import type { Machine, ProviderRoom } from "../../shared/config/index"
import { checkReviewerRoom } from "./reviewer-room"

export type RunReading =
  | { readonly kind: "read"; readonly run: string | null; readonly status: RunnerResult["status"]; readonly reviewerRoom?: ProviderRoom }
  | { readonly kind: "unread"; readonly reason: string }

export type ReadTaskRun = (task: TaskRecord, home: string, machine: Machine) => Effect.Effect<RunReading, never, RunnerRequirements>

export const readTaskRun: ReadTaskRun = (task, home, machine) =>
  readRunResult(task.spec.id, home, runLabel(home, task.spec.id, task.spec.kind), machine, task.parked?.origin?.reviewerQuota === undefined ? undefined : checkReviewerRoom).pipe(
    Effect.map((result): RunReading => {
      const room = result.run?.reviewerWait?.room
      return { kind: "read", run: result.run?.id ?? null, status: result.status, ...(room === undefined ? {} : { reviewerRoom: room }) }
    }),
    Effect.catchTag("RunnerError", (error) => Effect.succeed<RunReading>({ kind: "unread", reason: error.detail })),
    Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.succeed<RunReading>({ kind: "unread", reason: "the runner did not answer within 30 seconds" }) })
  )

export const otherRun = (reading: RunReading, run: string): string | null => {
  if (reading.kind === "unread") {
    return reading.reason
  }
  if (reading.run === run) {
    return null
  }
  return reading.run === null ? "no matching run was found" : "the runner now reports " + reading.run
}

export const parkedResumeWait = (task: TaskRecord, home: string, machine: Machine): Effect.Effect<string | null, never, RunnerRequirements> => {
  const origin = task.parked?.origin
  if (origin === undefined) {
    return Effect.succeed(null)
  }
  return readTaskRun(task, home, machine).pipe(
    Effect.map((reading) => {
      const other = otherRun(reading, origin.run)
      if (other !== null) {
        return "parked run " + origin.run + " is unavailable on " + origin.machine + ": " + other
      }
      if (reading.kind !== "read") {
        return reading.reason
      }
      if (reading.status === "running" || reading.status === "paused" || reading.status === "queued" || reading.status === "stashed") {
        return "parked run " + origin.run + " is still " + reading.status + " on " + origin.machine
      }
      if (origin.reviewerQuota !== undefined && reading.reviewerRoom?.kind !== "room") {
        return reading.reviewerRoom?.reason ?? origin.reviewerQuota
      }
      return null
    })
  )
}
