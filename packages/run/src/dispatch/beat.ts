import { DateTime, Duration, Effect, type FileSystem, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { backlogPaths, type BacklogError, claimTask, closeStartedTask, ensureBacklog, listTasks, publishClosed, releaseTask, writeTaken } from "./backlog"
import type { ConfigError } from "../json-file"
import { type Account, type DispatchConfig, type Machine, type Project, readDispatchConfig, readProjects } from "./config"
import { dependencyOpen, type MachineRoom, placeTask, readRoom } from "./beat-place"
import { type QuotaReading, readQuota } from "./quota"
import type { Claim, TaskFileError, TaskRecord } from "./task-record"
import { encodeRenewal, encodeToken, readToken, type RunToken, tokenLive } from "./token"
import { taskLabel } from "./pueue-status"
import { closingFromResult, readClosing, readResultThrough } from "./runner-result"
import type { Command } from "./runner"

export type { MachineRoom } from "./beat-place"
export { dependencyOpen, placeTask, readRoom } from "./beat-place"

export type BeatAction =
  | { readonly kind: "started"; readonly task: string; readonly machine: string; readonly account: string; readonly log: string }
  | { readonly kind: "start-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | { readonly kind: "lost"; readonly task: string }
  | { readonly kind: "given-back"; readonly task: string; readonly machine: string }
  | { readonly kind: "waits"; readonly task: string; readonly reason: string }
  | { readonly kind: "renewed"; readonly task: string; readonly machine: string }
  | { readonly kind: "renew-failed"; readonly task: string; readonly machine: string; readonly reason: string }
  | { readonly kind: "closed"; readonly task: string; readonly machine: string; readonly outcome: "done" | "failed"; readonly reason: string }
  | { readonly kind: "close-failed"; readonly task: string; readonly machine: string; readonly reason: string }

export interface BeatReport {
  readonly beat: string
  readonly at: string
  readonly quota: QuotaReading
  readonly room: ReadonlyArray<MachineRoom>
  readonly actions: ReadonlyArray<BeatAction>
}

type BeatRequirements = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

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

type StartResult = { readonly kind: "started" } | { readonly kind: "failed"; readonly reason: string }

type Credential =
  | { readonly kind: "file"; readonly provider: string; readonly tokenFile: string }
  | { readonly kind: "token"; readonly provider: string; readonly token: RunToken }
  | { readonly kind: "none"; readonly provider: string }

// Effect's spawner takes no file for stdio, so a shell sends the start command's output to the task's log.
const logToTaskLog = ["sh", "-c", "exec \"$@\" >> \"$ORC_TASK_LOG\" 2>&1", "orc-start"] as const

const bytesOf = (text: string) => Stream.make(new TextEncoder().encode(text))

// The start command leads its own session and is unreferenced before the scope closes, so the spawner leaves it running and the beat exits without it.
// The token is written whole before the scope closes, because closing the scope stops the fiber that writes it.
const handOn = (
  machine: Machine,
  env: Record<string, string>,
  stdin: string | null
): Effect.Effect<StartResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [shell, ...args] = logToTaskLog
    const handle = yield* spawner.spawn(ChildProcess.make(shell, [...args, ...machine.start], {
      env,
      extendEnv: true,
      detached: true,
      stdin: stdin === null ? "ignore" : "pipe",
      stdout: "ignore",
      stderr: "ignore"
    }))
    if (stdin !== null) {
      yield* Stream.run(bytesOf(stdin), handle.stdin)
    }
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
  credential: Credential
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
    const env = {
      ORC_TASK_LOG: log,
      ORC_TASK_ID: task.spec.id,
      ORC_TASK_FILE: backlogPaths(root).taskFile("taken", task.spec.id),
      ORC_TASK_PROJECT: task.spec.project,
      ORC_TASK_CHECKOUT: checkout,
      ORC_TASK_MACHINE: machine.name,
      ORC_TASK_PROVIDER: credential.provider,
      ORC_TASK_ACCOUNT: claim.account,
      ORC_TASK_TOKEN_FILE: credential.kind === "file" ? credential.tokenFile : ""
    }
    const result = credential.kind === "token"
      ? yield* encodeToken(credential.token).pipe(
        Effect.flatMap((stdin) => handOn(machine, env, stdin)),
        Effect.catchTag("TokenEncodeError", (error) => Effect.succeed<StartResult>({ kind: "failed", reason: "the " + error.what + " would not encode" }))
      )
      : yield* handOn(machine, env, null)
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
  readonly home: string
  readonly beat: string
  readonly config: DispatchConfig
  readonly projects: ReadonlyArray<Project>
  readonly tasks: ReadonlyArray<TaskRecord>
  readonly account: Account | null
  readonly live: Array<{ readonly machine: string; readonly slots: number; busy: number }>
  readonly tokens: TokenCache
}

type TokenCheck = { readonly kind: "live"; readonly token: RunToken } | { readonly kind: "waits"; readonly reason: string }

// One beat reads each account's token once, so every start and renewal in it carries the same token.
type TokenCache = Map<string, TokenCheck>

const checkToken = (
  tokens: TokenCache,
  account: Extract<Account, { readonly kind: "token-command" }>
): Effect.Effect<TokenCheck, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const cached = tokens.get(account.name)
    if (cached !== undefined) {
      return cached
    }
    const reading = yield* readToken(account.tokenCommand)
    const now = yield* DateTime.now
    const check: TokenCheck = reading.kind === "unread"
      ? { kind: "waits", reason: "the token for " + account.name + " is unread: " + reading.reason }
      : tokenLive(reading.token.expiresAt, now)
      ? { kind: "live", token: reading.token }
      : { kind: "waits", reason: "the token for " + account.name + " runs out at " + DateTime.formatIso(reading.token.expiresAt) }
    tokens.set(account.name, check)
    return check
  })

const credentialFor = (
  context: BeatContext,
  account: Account
): Effect.Effect<Credential | { readonly kind: "waits"; readonly reason: string }, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const provider = context.config.quota.provider
    switch (account.kind) {
      case "token-file": {
        return { kind: "file", provider, tokenFile: account.tokenFile }
      }
      case "none": {
        return { kind: "none", provider }
      }
      case "token-command": {
        const check = yield* checkToken(context.tokens, account)
        return check.kind === "waits" ? check : { kind: "token", provider, token: check.token }
      }
    }
  })

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
      return waits("no " + context.config.quota.provider + " account has room")
    }
    const credential = yield* credentialFor(context, context.account)
    if (credential.kind === "waits") {
      return waits(credential.reason)
    }
    if (!(yield* claimTask(context.root, task.spec.id))) {
      return { kind: "lost", task: task.spec.id } satisfies BeatAction
    }
    const slot = context.live.find((entry) => entry.machine === placement.machine.name)
    if (slot !== undefined) {
      slot.busy += 1
    }
    const claim: Claim = { beat: context.beat, machine: placement.machine.name, account: context.account.name, takenAt: yield* nowIso }
    const action = yield* startTask(context.root, task, claim, placement.checkout, placement.machine, credential)
    if (slot !== undefined) {
      if (action.kind === "given-back") {
        slot.busy = slot.slots
      } else if (action.kind !== "started") {
        slot.busy -= 1
      }
    }
    return action
  })

const renewSeconds = 30

const closeSeconds = 30

// The sweep closes only runs its own start command queued, so a custom start keeps owning its tasks.
const ownedBySweep = (machine: Machine): boolean =>
  machine.start.some((word, index) => word === "runner" && machine.start[index + 1] === "start")

const throughOf = (values: ReadonlyArray<string>): Command | null => {
  const cut = values.indexOf("--")
  if (cut === -1) {
    return null
  }
  const rest = values.slice(cut + 1)
  const [first = "", ...others] = rest
  if (first === "") {
    return null
  }
  return [first, ...others]
}

const throughFor = (machine: Machine): Command | null => ownedBySweep(machine) ? throughOf(machine.start) : null

const sendRenewal = (renew: Machine["renew"] & {}, stdin: string): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, ...args] = renew
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { stdin: "pipe", stdout: "ignore", stderr: "ignore" }))
    yield* Stream.run(bytesOf(stdin), handle.stdin)
    const exitCode = yield* handle.exitCode
    return exitCode === 0 ? null : "the renew command exited " + exitCode
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: Duration.seconds(renewSeconds), orElse: () => Effect.succeed("the renew command timed out") }),
    Effect.catch((error) => Effect.succeed("the renew command did not run: " + error.message))
  )

// A started run holds only the token it was handed, so each beat hands it the account's current one before that runs out.
const renewTask = (context: BeatContext, task: TaskRecord): Effect.Effect<Option.Option<BeatAction>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (task.state.kind !== "started") {
      return Option.none()
    }
    const claim = task.state.claim
    const machine = context.config.machines.find((entry) => entry.name === claim.machine)
    const account = context.config.quota.accounts.find((entry) => entry.name === claim.account)
    if (machine?.renew === undefined || account === undefined || account.kind !== "token-command") {
      return Option.none()
    }
    const failed = (reason: string): BeatAction => ({ kind: "renew-failed", task: task.spec.id, machine: machine.name, reason })
    const check = yield* checkToken(context.tokens, account)
    if (check.kind === "waits") {
      return Option.some(failed(check.reason))
    }
    const renew = machine.renew
    const refused = yield* encodeRenewal({ task: task.spec.id, ...check.token, label: taskLabel(context.home, task.spec.id) }).pipe(
      Effect.flatMap((renewal) => sendRenewal(renew, renewal)),
      Effect.catchTag("TokenEncodeError", (error) => Effect.succeed("the " + error.what + " would not encode"))
    )
    return Option.some(refused === null ? { kind: "renewed", task: task.spec.id, machine: machine.name } : failed(refused))
  })

// A finished run closes its task here, because no other beat step reads a started task after its run ends.
const closeFinished = (
  context: BeatContext,
  task: TaskRecord
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (task.state.kind !== "started") {
      return Option.none()
    }
    const claim = task.state.claim
    const label = taskLabel(context.home, task.spec.id)
    const machine = context.config.machines.find((entry) => entry.name === claim.machine)
    if (machine === undefined || !ownedBySweep(machine)) {
      return Option.none()
    }
    const through = throughFor(machine)
    const read = through === null ? readClosing(task.spec.id, context.home, label) : readResultThrough(through, task.spec.id, label).pipe(Effect.map(closingFromResult))
    const outcome = yield* read.pipe(
      Effect.map((closing) => ({ kind: "read" as const, closing })),
      Effect.catchTag("RunnerError", (error) => Effect.succeed({ kind: "unread" as const, reason: error.detail })),
      Effect.timeoutOrElse({
        duration: Duration.seconds(closeSeconds),
        orElse: () => Effect.succeed({ kind: "unread" as const, reason: "the close read timed out after " + closeSeconds + " seconds" })
      })
    )
    if (outcome.kind === "unread") {
      return Option.some({ kind: "close-failed", task: task.spec.id, machine: claim.machine, reason: outcome.reason } satisfies BeatAction)
    }
    const closing = outcome.closing
    if (closing === null) {
      return Option.none()
    }
    const closed = yield* closeStartedTask(context.root, task.spec.id, closing.outcome, closing.reason, yield* nowIso).pipe(
      Effect.catchTag("BacklogError", () => Effect.succeed(null))
    )
    if (closed === null) {
      return Option.none()
    }
    return Option.some({
      kind: "closed",
      task: task.spec.id,
      machine: task.state.claim.machine,
      outcome: closing.outcome,
      reason: closing.reason
    } satisfies BeatAction)
  })

export const runBeat = (
  root: string,
  home: string
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
      home,
      beat,
      config,
      projects,
      tasks,
      account: quota.kind === "read" ? (config.quota.accounts.find((account) => account.name === quota.pick) ?? null) : null,
      live: room.map((entry) => ({ ...entry })),
      tokens: new Map()
    }
    const closings = yield* Effect.forEach(tasks.filter((task) => task.state.kind === "started"), (task) => closeFinished(context, task))
    const closed = closings.flatMap(Option.toArray)
    for (const action of closed) {
      if (action.kind === "closed") {
        const slot = context.live.find((entry) => entry.machine === action.machine)
        if (slot !== undefined) {
          slot.busy -= 1
        }
      }
    }
    const current = yield* listTasks(root)
    const fresh: BeatContext = { ...context, tasks: current }
    const renewals = yield* Effect.forEach(current, (task) => renewTask(fresh, task))
    const actions = yield* Effect.forEach(current.filter((task) => task.state.kind === "new"), (task) => considerTask(fresh, task))
    return { beat, at, quota, room: readRoom(config.machines, current), actions: [...closed, ...renewals.flatMap(Option.toArray), ...actions] }
  })
