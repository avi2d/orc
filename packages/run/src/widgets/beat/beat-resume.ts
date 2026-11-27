import { Duration, Effect } from "effect"
import { runLabel, type TaskRecord } from "../../entities/backlog/index"
import { readRunResult, type RunnerRequirements, type RunnerResult } from "../../features/queueing-a-task/index"
import type { Machine, RoomReading } from "../../shared/config/index"

export type RunReading =
  | { readonly kind: "read"; readonly run: string | null; readonly status: RunnerResult["status"] }
  | { readonly kind: "unread"; readonly reason: string }

export type ReadTaskRun = (task: TaskRecord, home: string, machine: Machine) => Effect.Effect<RunReading, never, RunnerRequirements>

export const readTaskRun: ReadTaskRun = (task, home, machine) =>
  readRunResult(task.spec.id, home, runLabel(home, task.spec.id, task.spec.kind), machine).pipe(
    Effect.map((result): RunReading => ({ kind: "read", run: result.run?.id ?? null, status: result.status })),
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

// The resumed run picks its reviewer again from the chain, so one entry with room is enough to resume it.
export const reviewerRoomWait = (task: TaskRecord, roomOf: RoomReading): string | null => {
  const wait = task.parked?.reviewerWait
  if (wait === undefined) {
    return null
  }
  const full = wait.reviewers.flatMap((reviewer) => {
    const room = roomOf(reviewer)
    return room.kind === "room" ? [] : [reviewer.model + ": " + room.reason]
  })
  return full.length < wait.reviewers.length ? null : "parked until a reviewer in the chain has room: " + full.join("; ")
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
      return reading.kind === "read" && (reading.status === "running" || reading.status === "paused" || reading.status === "queued" || reading.status === "stashed")
        ? "parked run " + origin.run + " is still " + reading.status + " on " + origin.machine
        : null
    })
  )
}
