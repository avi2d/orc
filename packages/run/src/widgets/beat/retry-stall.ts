import { Effect, FileSystem, Option, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { runLabel, type BacklogError, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import type { Progress, StalledAction } from "../../entities/attention/index"
import { killHeld, killHeldThrough } from "../../features/queueing-a-task/index"
import { type DispatchConfig, throughFor } from "../../shared/config/index"
import { closeFinished, retryDeadRun, type CloseContext } from "./beat-close"
import { flagStall } from "./stall"

export const retryStalled = (
  root: string,
  home: string,
  config: DispatchConfig,
  task: TaskRecord,
  reading: Progress,
  stall: Option.Option<StalledAction>
): Effect.Effect<Progress, TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (Option.isNone(stall) || reading.kind !== "running" || reading.run === undefined || task.retry !== undefined || task.state.kind !== "started") {
      return reading
    }
    const machineName = task.state.claim.machine
    const machine = config.machines.find((entry) => entry.name === machineName)
    if (machine === undefined) return reading
    const through = throughFor(machine)
    const label = runLabel(home, task.spec.id, task.spec.kind)
    const stopped = yield* (through === null ? killHeld(home, task.spec.id, label) : killHeldThrough(through, task.spec.id, label)).pipe(
      Effect.as(true),
      Effect.catchTag("RunnerError", () => Effect.succeed(false))
    )
    return stopped ? yield* retryDeadRun(root, task.spec.id, machine.name, reading.run) : reading
  })

export const checkStalledRuns = (
  context: CloseContext,
  started: ReadonlyArray<TaskRecord>
): Effect.Effect<{ readonly progress: ReadonlyArray<Progress>; readonly stalls: ReadonlyArray<Option.Option<StalledAction>> }, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const reads = yield* Effect.forEach(started, (task) => closeFinished(context, task))
    const stalls = yield* Effect.forEach(started, (task, index) => flagStall(context.root, task, reads[index] ?? { kind: "untracked" }))
    const progress = yield* Effect.forEach(started, (task, index) => retryStalled(context.root, context.home, context.config, task, reads[index] ?? { kind: "untracked" }, stalls[index]))
    return { progress, stalls }
  })
