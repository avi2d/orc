import { DateTime, Duration, Effect, FileSystem, Option, type Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { backlogPaths, type BacklogError, claimUnheld, ensureBacklog, listTasks, publishClosed, releaseTask, writeTaken, type Claim, type DeciderOwns, type TaskFileError, type TaskRecord, runLabel } from "../../entities/backlog/index"
import type { ConfigError } from "../../shared/config/index"
import { type Account, type DispatchConfig, type Machine, type Project, readDispatchConfig, readProjects } from "../../shared/config/index"
import { type MachineRoom, type Placed, placeTask, readRoom, taskWait } from "./beat-place"
import { type QuotaReading, readQuota } from "./quota"
import { encodeRenewal, encodeToken, readToken, type RunToken, tokenLive } from "../../entities/token/index"
import type { BeatAction, Progress } from "../../entities/attention/index"
import { closeFinished } from "./beat-close"
import { openRunDeaths, routeTaskItems } from "../../entities/attention/index"
import { attentionActions } from "./beat-attention"
import { type AskDecider, askDeciderWithPi, decideReviewQuestions } from "../../features/decider/index"
import { handAnswersToResume } from "../../entities/parked-runs/index"
import { readMachineLoad, readOverloaded, type ReadLoad } from "./load"
import { flagStall } from "./stall"
import { readPullRequest } from "../../entities/pull-request/index"
import { prEvents, type ReadPullRequest } from "./task-events"
import { mergedIds } from "../../entities/events/index"
import { type ReadUpstream, readUpstream, watchUpstream } from "./upstream"

export type { BeatAction } from "../../entities/attention/index"
export type { MachineRoom } from "./beat-place"
export { placeTask, readRoom } from "./beat-place"

export interface BeatReport {
  readonly beat: string
  readonly at: string
  readonly quota: QuotaReading
  readonly room: ReadonlyArray<MachineRoom>
  readonly actions: ReadonlyArray<BeatAction>
}

type BeatRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

type StartResult = { readonly kind: "started" } | { readonly kind: "failed"; readonly reason: string }

type Credential =
  | { readonly kind: "file"; readonly provider: string; readonly tokenFile: string }
  | { readonly kind: "token"; readonly provider: string; readonly token: RunToken }
  | { readonly kind: "none"; readonly provider: string }
  | { readonly kind: "claude-config"; readonly provider: string; readonly configDirs: Readonly<Record<string, string>> }

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
  place: Placed,
  credential: Credential
): Effect.Effect<BeatAction, BacklogError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const machine = place.machine
    const taken: TaskRecord = { ...task, state: { kind: "taken", claim } }
    yield* writeTaken(root, taken)
    if (yield* machineOverfull(root, machine)) {
      yield* releaseTask(root, taken)
      return { kind: "given-back", task: task.spec.id, machine: machine.name } satisfies BeatAction
    }
    const log = backlogPaths(root).logFile(task.spec.id)
    yield* writeTaken(root, { ...handAnswersToResume(task), state: { kind: "started", claim, started: { at: yield* nowIso, log } } })
    const env = {
      ORC_TASK_LOG: log,
      ORC_TASK_ID: task.spec.id,
      ORC_TASK_FILE: backlogPaths(root).taskFile("taken", task.spec.id),
      ORC_TASK_PROJECT: task.spec.project,
      ORC_TASK_CHECKOUT: place.checkout,
      ORC_TASK_DELIVERY: place.delivery,
      ORC_TASK_INSTRUCTIONS: place.instructions ?? "",
      ORC_TASK_MACHINE: machine.name,
      ORC_TASK_PROVIDER: credential.provider,
      ORC_TASK_ACCOUNT: claim.account,
      ORC_TASK_TOKEN_FILE: credential.kind === "file" ? credential.tokenFile : "",
      ORC_TASK_CLAUDE_CONFIG_DIR: credential.kind === "claude-config" ? credential.configDirs[machine.name] ?? "" : ""
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
      ...task,
      state: { kind: "closed", claim, closing: { outcome: "start-failed", reason: result.reason }, closedAt: yield* nowIso, postedAt: null }
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
  readonly merged: ReadonlySet<string>
  readonly account: Account | null
  readonly live: Array<{ readonly machine: string; readonly slots: number; busy: number }>
  readonly overloaded: ReadonlyMap<string, string>
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
      case "claude-config": {
        return { kind: "claude-config", provider, configDirs: account.configDirs }
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
  deciderOwns: DeciderOwns,
  task: TaskRecord
): Effect.Effect<BeatAction, BacklogError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const waits = (reason: string): BeatAction => ({ kind: "waits", task: task.spec.id, reason })
    const waiting = taskWait(task, context.tasks, context.merged, deciderOwns)
    if (waiting !== null) {
      return waits(waiting)
    }
    const placement = placeTask(task, context.config, context.projects, context.live, context.overloaded)
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
    const claimed = yield* claimUnheld(context.root, task.spec.id, deciderOwns)
    if (claimed.kind !== "claimed") {
      return claimed.kind === "lost" ? { kind: "lost", task: task.spec.id } satisfies BeatAction : waits(claimed.reason)
    }
    const slot = context.live.find((entry) => entry.machine === placement.machine.name)
    if (slot !== undefined) {
      slot.busy += 1
    }
    const claim: Claim = { beat: context.beat, machine: placement.machine.name, account: context.account.name, takenAt: yield* nowIso }
    const action = yield* startTask(context.root, claimed.record, claim, placement, credential)
    if (slot !== undefined) {
      if (action.kind === "given-back") {
        slot.busy = slot.slots
      } else if (action.kind !== "started") {
        slot.busy -= 1
      }
    }
    return action
  })

const settledProgress = (
  progress: ReadonlyArray<Progress>
): { readonly closed: ReadonlyArray<BeatAction>; readonly asking: ReadonlyArray<BeatAction> } => ({
  closed: progress.flatMap((entry) => entry.kind === "ended" ? [entry.action] : []),
  asking: progress.flatMap((entry) => entry.kind === "running" && entry.action !== null ? [entry.action] : [])
})

const releaseClosedSlots = (live: BeatContext["live"], closed: ReadonlyArray<BeatAction>): void => {
  for (const action of closed) {
    if (action.kind === "closed" || action.kind === "parked" || action.kind === "split") {
      const slot = live.find((entry) => entry.machine === action.machine)
      if (slot !== undefined) {
        slot.busy -= 1
      }
    }
  }
}

const renewSeconds = 30

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
    const refused = yield* encodeRenewal({ task: task.spec.id, ...check.token, label: runLabel(context.home, task.spec.id, task.spec.kind) }).pipe(
      Effect.flatMap((renewal) => sendRenewal(renew, renewal)),
      Effect.catchTag("TokenEncodeError", (error) => Effect.succeed("the " + error.what + " would not encode"))
    )
    return Option.some(refused === null ? { kind: "renewed", task: task.spec.id, machine: machine.name } : failed(refused))
  })

export interface BeatSources {
  readonly readLoad: ReadLoad
  readonly readPullRequest: ReadPullRequest
  readonly readUpstream: ReadUpstream
  readonly askDecider: AskDecider
}

export const liveSources = (home: string): BeatSources => ({ readLoad: readMachineLoad, readPullRequest, readUpstream, askDecider: askDeciderWithPi(home) })

const decideAndRelay = (
  root: string,
  context: BeatContext,
  started: ReadonlyArray<TaskRecord>,
  progress: ReadonlyArray<Progress>,
  current: ReadonlyArray<TaskRecord>,
  askDecider: AskDecider
): Effect.Effect<{ readonly latest: ReadonlyArray<TaskRecord>; readonly relayed: ReturnType<typeof settledProgress> }, BacklogError | TaskFileError, BeatRequirements> =>
  Effect.gen(function*() {
    const decided = yield* decideReviewQuestions(root, current, askDecider)
    const latest = decided.some((entry) => entry.verdict.kind === "answered") ? yield* listTasks(root) : current
    const answeredTasks = new Set(decided.flatMap((entry) => entry.verdict.kind === "answered" ? [entry.task] : []))
    const firstRunning = new Set(started.flatMap((task, index) => progress[index]?.kind === "running" ? [task.spec.id] : []))
    const relayProgress = answeredTasks.size === 0
      ? []
      : yield* Effect.forEach(latest.filter((task) => task.state.kind === "started" && answeredTasks.has(task.spec.id) && firstRunning.has(task.spec.id)), (task) => closeFinished(context, task))
    const relayed = settledProgress(relayProgress)
    releaseClosedSlots(context.live, relayed.closed)
    return { latest, relayed }
  })

export const runBeat = (
  root: string,
  home: string,
  sources: BeatSources
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
    const merged = yield* mergedIds(root)
    const room = readRoom(config.machines, tasks)
    const context: BeatContext = {
      root,
      home,
      beat,
      config,
      projects,
      tasks,
      merged,
      account: quota.kind === "read" ? (config.quota.accounts.find((account) => account.name === quota.pick) ?? null) : null,
      live: room.map((entry) => ({ ...entry })),
      overloaded: new Map(),
      tokens: new Map()
    }
    const started = tasks.filter((task) => task.state.kind === "started")
    const progress = yield* Effect.forEach(started, (task) => closeFinished(context, task))
    const settled = settledProgress(progress)
    const stalls = yield* Effect.forEach(started, (task, index) => flagStall(root, task, progress[index] ?? { kind: "untracked" }))
    releaseClosedSlots(context.live, settled.closed)
    const upstream = yield* watchUpstream(root, projects, sources.readUpstream, at)
    const current = yield* listTasks(root)
    yield* routeTaskItems(root, current, at)
    yield* openRunDeaths(root, settled.closed, at)
    const { latest, relayed } = yield* decideAndRelay(root, context, started, progress, current, sources.askDecider)
    const { reported, queue, deciderOwns } = yield* attentionActions(root, latest, [...settled.closed, ...relayed.closed, ...settled.asking, ...relayed.asking], at)
    const queued = latest.filter((task) => task.state.kind === "new")
    const overloaded = queued.length === 0 ? new Map<string, string>() : yield* readOverloaded(config.machines, home, sources.readLoad)
    const fresh: BeatContext = { ...context, tasks: latest, overloaded }
    const renewals = yield* Effect.forEach(latest, (task) => renewTask(fresh, task))
    const actions = yield* Effect.forEach(queued, (task) => considerTask(fresh, deciderOwns, task))
    yield* openRunDeaths(root, actions, at)
    const prs = yield* Effect.forEach(latest, (task) => prEvents(root, task, sources.readPullRequest, at))
    return { beat, at, quota, room: readRoom(config.machines, latest), actions: [
        ...reported,
        ...stalls.flatMap(Option.toArray),
        ...upstream,
        ...queue,
        ...renewals.flatMap(Option.toArray),
        ...actions,
        ...prs.flatMap(Option.toArray)
      ]
    }
  })
