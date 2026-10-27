import { DateTime, Duration, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, type BacklogError, claimTask, ensureBacklog, listTasks, publishClosed, releaseTask, writeTaken } from "./backlog"
import { checkoutOn, type ConfigError, type DispatchConfig, type Machine, type Project, readDispatchConfig, readProjects } from "./config"
import { type QuotaReading, readQuota } from "./quota"
import type { Claim, TaskFileError, TaskRecord } from "./task-record"

export interface MachineRoom {
  readonly machine: string
  readonly slots: number
  readonly busy: number
}

export type BeatAction =
  | { readonly kind: "started"; readonly task: string; readonly machine: string; readonly account: string; readonly note: string }
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

const startSeconds = 120
const noteLength = 200

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

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim().slice(0, noteLength) ?? ""

const outputSettleMillis = 500

type StartResult = { readonly kind: "started"; readonly note: string } | { readonly kind: "failed"; readonly reason: string }

const collectStream = (
  stream: ReadableStream<Uint8Array> | null,
  append: (text: string) => void
): (() => void) => {
  if (stream === null) {
    return () => {}
  }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let settled = false
  const release = (): void => {
    if (!settled) {
      settled = true
      reader.releaseLock()
    }
  }
  const step = (): void => {
    reader.read().then((next) => {
      if (next.done) {
        release()
        return
      }
      append(decoder.decode(next.value, { stream: true }))
      step()
    }, release)
  }
  step()
  return () => {
    if (!settled) {
      void reader.cancel().then(undefined, () => undefined)
    }
  }
}

const runStart = (
  machine: Machine,
  env: Record<string, string>
): Effect.Effect<StartResult> =>
  Effect.try({
    try: () => Bun.spawn([...machine.start], {
      env: { ...Bun.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    }),
    catch: (cause) => "the start command did not run: " + (cause instanceof Error ? cause.message : String(cause))
  }).pipe(
    Effect.matchEffect({
      onFailure: (reason) => Effect.succeed<StartResult>({ kind: "failed", reason }),
      onSuccess: (child) =>
        Effect.callback((resume: (effect: Effect.Effect<StartResult>) => void) => {
            let stdout = ""
            let stderr = ""
            let finished = false
            let timer: ReturnType<typeof setTimeout> | undefined
            const cancelStdout = collectStream(child.stdout, (text) => {
              stdout += text
            })
            const cancelStderr = collectStream(child.stderr, (text) => {
              stderr += text
            })
            const finish = (result: StartResult): void => {
              if (finished) {
                return
              }
              finished = true
              timer = setTimeout(() => {
                cancelStdout()
                cancelStderr()
                resume(Effect.succeed(result))
              }, outputSettleMillis)
            }
            void child.exited.then((code) => {
              finish(code === 0
                ? { kind: "started", note: lastLine(stdout) } satisfies StartResult
                : { kind: "failed", reason: "the start command exited " + code + ": " + lastLine(stderr) } satisfies StartResult)
            }, (cause: unknown) => {
              finish({ kind: "failed", reason: "the start command did not run: " + (cause instanceof Error ? cause.message : String(cause)) })
            })
          return Effect.sync(() => {
            clearTimeout(timer)
            cancelStdout()
            cancelStderr()
            if (!finished) {
              child.kill("SIGTERM")
            }
          })
        })
    }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(startSeconds),
      orElse: () => Effect.succeed<StartResult>({ kind: "failed", reason: "the start command ran past " + startSeconds + " seconds" })
    })
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
  machine: Machine
): Effect.Effect<BeatAction, BacklogError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const taken: TaskRecord = { spec: task.spec, state: { kind: "taken", claim } }
    yield* writeTaken(root, taken)
    if (yield* machineOverfull(root, machine)) {
      yield* releaseTask(root, taken)
      return { kind: "given-back", task: task.spec.id, machine: machine.name } satisfies BeatAction
    }
    yield* writeTaken(root, { spec: task.spec, state: { kind: "started", claim, started: { at: yield* nowIso, note: "" } } })
    const result = yield* runStart(machine, {
      ORC_TASK_ID: task.spec.id,
      ORC_TASK_FILE: backlogPaths(root).taskFile("taken", task.spec.id),
      ORC_TASK_PROJECT: task.spec.project,
      ORC_TASK_CHECKOUT: checkout,
      ORC_TASK_MACHINE: machine.name,
      ORC_TASK_ACCOUNT: claim.account
    })
    if (result.kind === "started") {
      return { kind: "started", task: task.spec.id, machine: machine.name, account: claim.account, note: result.note } satisfies BeatAction
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
  readonly account: string | null
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
    const claim: Claim = { beat: context.beat, machine: placement.machine.name, account: context.account, takenAt: yield* nowIso }
    const action = yield* startTask(context.root, task, claim, placement.checkout, placement.machine)
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
    const quota = yield* readQuota(config.quota)
    const tasks = yield* listTasks(root)
    const room = readRoom(config.machines, tasks)
    const context: BeatContext = {
      root,
      beat,
      config,
      projects,
      tasks,
      account: quota.kind === "read" ? quota.pick : null,
      live: room.map((entry) => ({ ...entry }))
    }
    const actions = yield* Effect.forEach(tasks.filter((task) => task.state.kind === "new"), (task) => considerTask(context, task))
    return { beat, at, quota, room, actions }
  })
