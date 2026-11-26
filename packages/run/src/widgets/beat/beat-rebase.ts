import { Effect } from "effect"
import { BacklogError, backlogPaths, runLabel, taskPr, type TaskRecord } from "../../entities/backlog/index"
import { rebaseClosedTask } from "../../entities/parked-runs/index"
import { readRunResult } from "../../features/queueing-a-task/index"
import { readDispatchConfig } from "../../shared/config/index"
import type { PullRequestView } from "../../entities/pull-request/index"

export const queueRebase = Effect.fnUntraced(function*(root: string, home: string, task: TaskRecord, view: PullRequestView, at: string) {
  const pr = taskPr(task)
  if (pr === null || task.state.kind !== "closed" || task.state.claim === null) {
    return false
  }
  if (task.rebase?.pr === pr && task.rebase.head === view.headRefOid) {
    return false
  }
  const machineName = task.state.claim.machine
  const config = yield* readDispatchConfig(backlogPaths(root).dispatchConfig).pipe(
    Effect.mapError((error) => new BacklogError({ detail: error.file + ": " + error.detail }))
  )
  const machine = config.machines.find((entry) => entry.name === machineName)
  if (machine === undefined) {
    return yield* new BacklogError({ detail: "the machine " + machineName + " that ran " + task.spec.id + " is not in dispatch.json" })
  }
  const result = yield* readRunResult(task.spec.id, home, runLabel(home, task.spec.id, task.spec.kind), machine).pipe(
    Effect.mapError((error) => new BacklogError({ detail: error.detail }))
  )
  if (result.run === undefined || result.run === null) {
    return yield* new BacklogError({ detail: "the runner on " + machineName + " holds no run of " + task.spec.id + " to rebase" })
  }
  yield* rebaseClosedTask(root, task.spec.id, { pr, head: view.headRefOid, at }, { machine: machineName, run: result.run.id }).pipe(
    Effect.mapError((error) => error instanceof BacklogError ? error : new BacklogError({ detail: error.file + ": " + error.detail }))
  )
  return true
})
