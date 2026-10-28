import { DateTime, Effect, type FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { backlogPaths, type BacklogError, claimTask, ensureBacklog, listTasks, publishClosed, releaseTask, writeTaken } from "./backlog"
import { type Account, checkoutOn, type ConfigError, type DispatchConfig, type Machine, type Project, readDispatchConfig, readProjects } from "./config"
import { type QuotaReading, readQuota } from "./quota"
import type { Claim, TaskFileError, TaskRecord } from "./task-record"

export interface MachineRoom {
  readonly machine: string
  readonly slots: number
  readonly busy: number
}

export type BeatAction =
  | { readonly kind: "started"; readonly task: string; readonly machine: string; readonly account: string; readonly log: string }
  | { readonly kind: "start-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | { readonly kind: "lost"; readonly task: string }
  | { readonly kind: "given-back"; readonly task: string; readonly machine: string }
  | { readonly kind: "waits"; readonly task: string; readonly reason: string }

export interface BeatReport {
  readonly beat: string
  readonly at: string
  readonly quota: QuotaReading
  readonly room: ReadonlyArray<MachineRoom>
  readonly actions: ReadonlyArray<BeatAction>
}

type BeatRequirements = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

export const readRoom = (machines: ReadonlyArray<Machine>, tasks: ReadonlyArray<TaskRecord>): ReadonlyArray<MachineRoom> =>
  machines.map((machine) => ({
    machine: machine.name,
    slots: machine.slots,
    busy: tasks.filter((task) =>
      (task.state.kind === "taken" || task.state.kind === "started") && task.state.claim?.machine === machine.name
    ).length
  }))

const freeRoom = (room: MachineRoom): number => Math.max(0, room.slots - room.busy)

export const dependencyOpen = (dependency: TaskRecord | undefined): boolean =>
  dependency === undefined || dependency.state.kind !== "closed" || dependency.state.closing.outcome !== "done"

const dependencyWait = (task: TaskRecord, tasks: ReadonlyArray<TaskRecord>): string | null => {
  for (const id of task.spec.dependsOn) {
    const dependency = tasks.find((candidate) => candidate.spec.id === id)
    if (dependency === undefined) {
      return "waits on " + id + ", which the backlog does not hold"
    }
    if (dependencyOpen(dependency)) {
      return "waits on " + id
    }
  }
  return null
}

type Placement =
  | { readonly kind: "place"; readonly machine: Machine; readonly checkout: string }
  | { readonly kind: "waits"; readonly reason: string }

// A task that names a machine is placed there or nowhere, whatever room the other machines have.
export const placeTask = (
  task: TaskRecord,
  config: DispatchConfig,
  projects: ReadonlyArray<Project>,
  room: ReadonlyArray<MachineRoom>
): Placement => {
  const project = projects.find((candidate) => candidate.name === task.spec.project)
  if (project === undefined) {
    return { kind: "waits", reason: "the project " + task.spec.project + " is not in the project list" }
  }
  const pinned = task.spec.machine
  if (pinned !== null && !config.machines.some((machine) => machine.name === pinned)) {
    return { kind: "waits", reason: "the machine " + pinned + " is not in dispatch.json" }
  }
  const candidates = config.machines.flatMap((machine) => {
    const checkout = checkoutOn(project, machine.name)
    return (pinned === null || machine.name === pinned) && checkout !== null ? [{ machine, checkout }] : []
  })
  if (candidates.length === 0) {
    return { kind: "waits", reason: "the project " + project.name + " has no checkout on " + (pinned ?? "any machine") }
  }
  let best: { readonly machine: Machine; readonly checkout: string; readonly free: number } | null = null
  for (const candidate of candidates) {
    const free = freeRoom(room.find((entry) => entry.machine === candidate.machine.name) ?? { machine: candidate.machine.name, slots: 0, busy: 0 })
    if (free > (best?.free ?? 0)) {
      best = { ...candidate, free }
    }
  }
  if (best === null) {
    return { kind: "waits", reason: pinned === null ? "no machine with a checkout of " + project.name + " has room" : pinned + " has no room" }
  }
  return { kind: "place", machine: best.machine, checkout: best.checkout }
}

type StartResult = { readonly kind: "started" } | { readonly kind: "failed"; readonly reason: string }

// Effect's spawner takes no file for stdio, so a shell sends the start command's output to the task's log.
const logToTaskLog = ["sh", "-c", "exec \"$@\" >> \"$ORC_TASK_LOG\" 2>&1", "orc-start"] as const

// The start command leads its own session and is unreferenced before the scope closes, so the spawner leaves it running and the beat exits without it.
const handOn = (
  machine: Machine,
  env: Record<string, string>
): Effect.Effect<StartResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [shell, ...args] = logToTaskLog
    const handle = yield* spawner.spawn(ChildProcess.make(shell, [...args, ...machine.start], {
      env,
      extendEnv: true,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    }))
    yield* Effect.asVoid(handle.unref)
    return { kind: "started" } satisfies StartResult
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.succeed<StartResult>({ kind: "failed", reason: "the start command did not run: " + error.message }))
  )

// Each beat writes its claim before it counts, so of two beats racing for a machine's last slot at least one sees both claims.
const machineOverfull = (
  root: string,
  machine: Machine
): Effect.Effect<boolean, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  listTasks(root).pipe(
    Effect.map((tasks) => readRoom([machine], tasks).some((entry) => entry.busy > entry.slots))
  )

const startTask = (
  root: string,
  task: TaskRecord,
  claim: Claim,
  checkout: string,
  machine: Machine,
  tokenFile: string
): Effect.Effect<BeatAction, BacklogError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const taken: TaskRecord = { spec: task.spec, state: { kind: "taken", claim } }
    yield* writeTaken(root, taken)
    if (yield* machineOverfull(root, machine)) {
      yield* releaseTask(root, taken)
      return { kind: "given-back", task: task.spec.id, machine: machine.name } satisfies BeatAction
    }
    const log = backlogPaths(root).logFile(task.spec.id)
    yield* writeTaken(root, { spec: task.spec, state: { kind: "started", claim, started: { at: yield* nowIso, log } } })
    const result = yield* handOn(machine, {
      ORC_TASK_LOG: log,
      ORC_TASK_ID: task.spec.id,
      ORC_TASK_FILE: backlogPaths(root).taskFile("taken", task.spec.id),
      ORC_TASK_PROJECT: task.spec.project,
      ORC_TASK_CHECKOUT: checkout,
      ORC_TASK_MACHINE: machine.name,
      ORC_TASK_ACCOUNT: claim.account,
      ORC_TASK_TOKEN_FILE: tokenFile
    })
    if (result.kind === "started") {
      return { kind: "started", task: task.spec.id, machine: machine.name, account: claim.account, log } satisfies BeatAction
    }
    yield* publishClosed(root, {
      spec: task.spec,
      state: { kind: "closed", claim, closing: { outcome: "start-failed", reason: result.reason }, closedAt: yield* nowIso }
    })
    return { kind: "start-failed", task: task.spec.id, machine: machine.name, reason: result.reason } satisfies BeatAction
  })

interface BeatContext {
  readonly root: string
  readonly beat: string
  readonly config: DispatchConfig
  readonly projects: ReadonlyArray<Project>
  readonly tasks: ReadonlyArray<TaskRecord>
  readonly account: Account | null
  readonly live: Array<{ readonly machine: string; readonly slots: number; busy: number }>
}

const considerTask = (
  context: BeatContext,
  task: TaskRecord
): Effect.Effect<BeatAction, BacklogError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const waits = (reason: string): BeatAction => ({ kind: "waits", task: task.spec.id, reason })
    const waiting = dependencyWait(task, context.tasks)
    if (waiting !== null) {
      return waits(waiting)
    }
    const placement = placeTask(task, context.config, context.projects, context.live)
    if (placement.kind === "waits") {
      return waits(placement.reason)
    }
    if (context.account === null) {
      return waits("no Claude account has room")
    }
    if (!(yield* claimTask(context.root, task.spec.id))) {
      return { kind: "lost", task: task.spec.id } satisfies BeatAction
    }
    const slot = context.live.find((entry) => entry.machine === placement.machine.name)
    if (slot !== undefined) {
      slot.busy += 1
    }
    const claim: Claim = { beat: context.beat, machine: placement.machine.name, account: context.account.name, takenAt: yield* nowIso }
    const action = yield* startTask(context.root, task, claim, placement.checkout, placement.machine, context.account.tokenFile)
    if (slot !== undefined) {
      if (action.kind === "given-back") {
        slot.busy = slot.slots
      } else if (action.kind !== "started") {
        slot.busy -= 1
      }
    }
    return action
  })

export const runBeat = (
  root: string
): Effect.Effect<BeatReport, BacklogError | ConfigError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const paths = backlogPaths(root)
    const beat = "beat-" + crypto.randomUUID().slice(0, 8)
    const at = yield* nowIso
    const config = yield* readDispatchConfig(paths.dispatchConfig)
    const projects = yield* readProjects(paths.projects, config.machines)
    yield* ensureBacklog(root)
    const quota = yield* readQuota({ accounts: config.quota.accounts.map((account) => account.name), floorPercent: config.quota.floorPercent })
    const tasks = yield* listTasks(root)
    const room = readRoom(config.machines, tasks)
    const context: BeatContext = {
      root,
      beat,
      config,
      projects,
      tasks,
      account: quota.kind === "read" ? (config.quota.accounts.find((account) => account.name === quota.pick) ?? null) : null,
      live: room.map((entry) => ({ ...entry }))
    }
    const actions = yield* Effect.forEach(tasks.filter((task) => task.state.kind === "new"), (task) => considerTask(context, task))
    return { beat, at, quota, room, actions }
  })
