import { Duration, Effect } from "effect"
import { runLabel, type TaskRecord } from "../../entities/backlog/index"
import { readResult, readResultThrough, type RunnerRequirements } from "../../features/queueing-a-task/index"
import { type Machine, throughFor } from "../../shared/config/index"

export const parkedResumeWait = (task: TaskRecord, home: string, machine: Machine): Effect.Effect<string | null, never, RunnerRequirements> => {
  const origin = task.parked?.origin
  if (origin === undefined) {
    return Effect.succeed(null)
  }
  const label = runLabel(home, task.spec.id, task.spec.kind)
  const through = throughFor(machine)
  const reading = through === null ? readResult(task.spec.id, home, label) : readResultThrough(through, task.spec.id, label)
  const unavailable = "parked run " + origin.run + " is unavailable on " + origin.machine
  return reading.pipe(
    Effect.map((result) => {
      if (result.run?.id !== origin.run) {
        return unavailable + (result.run == null ? ": no matching run was found" : ": the runner now reports " + result.run.id)
      }
      return result.status === "running" || result.status === "paused" || result.status === "queued" || result.status === "stashed"
        ? "parked run " + origin.run + " is still " + result.status + " on " + origin.machine
        : null
    }),
    Effect.catchTag("RunnerError", (error) => Effect.succeed(unavailable + ": " + error.detail)),
    Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.succeed(unavailable + ": the runner did not answer within 30 seconds") })
  )
}
