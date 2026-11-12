import { DateTime, Effect, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, backlogPaths, closeStartedTask, listTasks, runLabel, type TaskFileError } from "../../entities/backlog/index"
import { routeTaskItems } from "../../entities/attention/index"
import { readDispatchConfig } from "../../shared/config/index"
import type { ConfigError } from "../../shared/config/index"
import { ownedBySweep, throughFor } from "../../shared/config/index"
import { killHeld, refuse as refuseRun } from "./runner"
import { RunnerError } from "../../shared/process/index"
import { killHeldThrough, readResult, readResultThrough } from "./runner-result"

export const stopNow = (
  id: string,
  root: string,
  home: string
): Effect.Effect<string, BacklogError | ConfigError | RunnerError | TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const record = (yield* listTasks(root)).find((candidate) => candidate.spec.id === id)
    if (record === undefined) {
      return yield* refuseRun("the backlog holds no " + id)
    }
    if (record.state.kind !== "started") {
      return yield* refuseRun(id + " is " + record.state.kind + ", and only a started task stops")
    }
    const started = record.state
    const machine = (yield* readDispatchConfig(backlogPaths(root).dispatchConfig)).machines.find((entry) => entry.name === started.claim.machine)
    if (machine === undefined) {
      return yield* refuseRun("the machine " + started.claim.machine + " is not in dispatch.json")
    }
    const through = throughFor(machine)
    if (!ownedBySweep(machine)) {
      return yield* refuseRun(id + " started on " + machine.name + ", which orc cannot reach, so close it by hand with orc backlog close " + id + " failed")
    }
    const label = runLabel(home, id, record.spec.kind)
    const line = through === null
      ? yield* killHeld(home, id, label)
      : yield* killHeldThrough(through, id, label)
    const after = through === null
      ? yield* readResult(id, home, label).pipe(Effect.orElseSucceed(() => null))
      : yield* readResultThrough(through, id, label).pipe(Effect.orElseSucceed(() => null))
    const closed = after?.run ?? null
    const at = DateTime.formatIso(yield* DateTime.now)
    const ended = yield* closeStartedTask(root, id, "stopped", closed?.endReason ?? "the captain stopped " + id, { pr: closed?.prLink ?? null, report: null }, at)
    yield* routeTaskItems(root, [ended], at)
    return line
  })
