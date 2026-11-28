import { Array as Arr, DateTime, Effect, FileSystem, Option, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, type BacklogError, closeStartedTask, runLabel, runDirFor, taskBranch, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { recordEvent } from "../../entities/events/index"
import { type BeatAction, openUnreachedMachine, type Progress, withdrawTaskItems, withdrawUnreachedMachine } from "../../entities/attention/index"
import { type DispatchConfig, ownedBySweep, readJsonFileIfPresent, throughFor } from "../../shared/config/index"
import { logWrittenAt, stallMillis } from "./stall"
import { endSplit } from "./beat-split"
import { type CloseReading, readClose, serveRunning } from "./beat-close-runner"
import { type AskedQuestion, parkForReviewerQuota, parkStartedTask, retryStartedTask } from "../../entities/parked-runs/index"
import { Asking, askingFileName } from "../../entities/review-gate/index"
import type { RunEnding } from "../../features/queueing-a-task/index"

export interface CloseContext {
  readonly root: string
  readonly home: string
  readonly config: DispatchConfig
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

// The beat records the start before it queues the run.
const missingRunnerGraceMillis = 10 * 60 * 1000

export const staleEndingOf = (startedAt: string, nowMillis: number, reading: CloseReading, unreadSinceMillis: number | null): RunEnding | null => {
  // Losing contact is not evidence that the run ended.
  if (reading.kind === "unreached") {
    return null
  }
  if (reading.kind === "unread") {
    if (unreadSinceMillis === null || Number.isNaN(unreadSinceMillis) || nowMillis - unreadSinceMillis <= missingRunnerGraceMillis) {
      return null
    }
    return { kind: "close", outcome: "failed", reason: reading.reason, pr: null, report: null }
  }
  const started = Date.parse(startedAt)
  if (Number.isNaN(started) || nowMillis - started <= missingRunnerGraceMillis) {
    return null
  }
  return reading.ending === null && reading.result.status === "unknown"
    ? { kind: "close", outcome: "failed", reason: "the runner holds no record of this task", pr: null, report: null }
    : null
}

export const ownLogEndingOf = (startedAt: string, logAt: string | null, nowMillis: number): RunEnding | null => {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started) || nowMillis - started <= stallMillis) {
    return null
  }
  if (logAt !== null) {
    const written = Date.parse(logAt)
    if (!Number.isNaN(written) && nowMillis - written <= stallMillis) {
      return null
    }
  }
  return { kind: "close", outcome: "failed", reason: "the machine keeps its own log, and its log has not grown for 30 minutes", pr: null, report: null }
}

type ParkEnding = Extract<RunEnding, { readonly kind: "park" }>
type CloseEnding = Extract<RunEnding, { readonly kind: "close" }>

const endParked = (
  root: string,
  home: string,
  task: TaskRecord,
  machine: string,
  ending: ParkEnding,
  run: string | undefined
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    const branch = task.parked?.branch ?? taskBranch(id)
    const live = yield* (run === undefined
      ? Effect.succeed<ReadonlyArray<AskedQuestion>>([])
      : readJsonFileIfPresent(runDirFor(home, run) + "/" + askingFileName, Asking).pipe(
        Effect.map((asking) => asking === null ? [] as ReadonlyArray<AskedQuestion> : [...asking.questions]),
        Effect.catchTag("ConfigError", () => Effect.succeed([] as ReadonlyArray<AskedQuestion>))
      ))
    const liveById = new Map(live.map((question) => [question.id, question] as const))
    const merged = Arr.map(ending.questions, (question) => {
      const rich = liveById.get(question.id)
      if (rich === undefined) {
        return question
      }
      return {
        ...question,
        ...(rich.options !== undefined ? { options: rich.options } : {}),
        ...(rich.recommendation !== undefined ? { recommendation: rich.recommendation } : {})
      }
    })
    const open = Arr.appendAll(merged, live.filter((question) => !ending.questions.some((known) => known.id === question.id)))
    const parked = yield* parkStartedTask(root, id, branch, open, yield* nowIso, run, ending.reason).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(null)))
    if (parked === null) {
      return Option.none()
    }
    if (parked.hold?.repeat === true && parked.hold.answer === null) {
      return Option.some({ kind: "held", task: id, machine, reason: parked.hold.reason } satisfies BeatAction)
    }
    const questions = (parked.parked?.questions ?? []).filter((question) => question.answer === null).map((question) => question.id)
    return Option.some({ kind: "parked", task: id, machine, branch, questions, decider: [] } satisfies BeatAction)
  })

const endClosed = (
  root: string,
  task: TaskRecord,
  machine: string,
  ending: CloseEnding
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const closed = yield* closeStartedTask(root, task.spec.id, ending.outcome, ending.reason, { pr: ending.pr, report: ending.report }, yield* nowIso).pipe(
      Effect.catchTag("BacklogError", () => Effect.succeed(null))
    )
    return closed === null
      ? Option.none()
      : Option.some({ kind: "closed", task: task.spec.id, machine, outcome: ending.outcome, reason: ending.reason, pr: ending.pr, report: ending.report } satisfies BeatAction)
  })

const endReviewerWait = Effect.fnUntraced(function*(root: string, task: TaskRecord, machine: string, reason: string, run: string | undefined) {
  if (run === undefined) {
    return Option.none<BeatAction>()
  }
  const parked = yield* parkForReviewerQuota(root, task.spec.id, run, reason, yield* nowIso).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(null)))
  return parked?.parked == null
    ? Option.none<BeatAction>()
    : Option.some({
      kind: "parked",
      task: task.spec.id,
      machine,
      branch: parked.parked.branch,
      questions: parked.parked.questions.filter((question) => question.answer === null).map((question) => question.id),
      decider: [],
      reason
    } satisfies BeatAction)
})

const endTask = (
  root: string,
  home: string,
  task: TaskRecord,
  machine: string,
  ending: RunEnding,
  run?: string
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  ending.kind === "reviewer-quota" ? endReviewerWait(root, task, machine, ending.wait.reason, run)
    : ending.kind === "park" ? endParked(root, home, task, machine, ending, run)
    : ending.kind === "split" ? endSplit(root, task, machine, ending)
    : endClosed(root, task, machine, ending)

const readSince = (
  fs: FileSystem.FileSystem,
  sinceFile: string,
  nowText: string
): Effect.Effect<number | null> =>
  fs.readFileString(sinceFile).pipe(
    Effect.map((text) => Date.parse(text)),
    Effect.catchTag("PlatformError", () => Effect.succeed<number | null>(null)),
    Effect.flatMap((parsed) =>
      parsed === null || Number.isNaN(parsed)
        ? fs.writeFileString(sinceFile, nowText).pipe(
          Effect.as<number | null>(null),
          Effect.catchTag("PlatformError", () => Effect.succeed<number | null>(null))
        )
        : Effect.succeed<number | null>(parsed)
    )
  )

const clearSince = (
  fs: FileSystem.FileSystem,
  sinceFile: string
): Effect.Effect<number | null> =>
  fs.remove(sinceFile, { force: true }).pipe(
    Effect.as<number | null>(null),
    Effect.catchTag("PlatformError", () => Effect.succeed<number | null>(null))
  )

const trackUnreached = (
  root: string,
  task: string,
  machine: string,
  reading: CloseReading,
  fs: FileSystem.FileSystem,
  nowText: string
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const unreachedFile = backlogPaths(root).unreachedFile(task)
    if (reading.kind === "unreached") {
      const since = yield* readSince(fs, unreachedFile, nowText)
      if (since !== null && Date.parse(nowText) - since > missingRunnerGraceMillis) {
        yield* openUnreachedMachine(root, task, machine, new Date(since).toISOString(), reading.reason, nowText)
      }
      return
    }
    if (yield* fs.exists(unreachedFile).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))) {
      yield* clearSince(fs, unreachedFile)
      yield* withdrawUnreachedMachine(root, task, nowText)
    }
  })

const trackReading = (
  context: CloseContext,
  task: string,
  machine: string,
  reading: CloseReading
): Effect.Effect<{ readonly nowText: string; readonly unreadSince: number | null }, BacklogError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const unreadFile = backlogPaths(context.root).unreadFile(task)
    const nowText = yield* nowIso
    const unreadSince = reading.kind === "unread"
      ? yield* readSince(fs, unreadFile, nowText)
      : yield* clearSince(fs, unreadFile)
    yield* trackUnreached(context.root, task, machine, reading, fs, nowText)
    return { nowText, unreadSince }
  })

const deadRunOf = (reading: CloseReading): string | undefined =>
  reading.kind === "read" && reading.result.status === "failed" && reading.result.reason !== "the run was killed" ? reading.result.run?.id : undefined

export const retryDeadRun = (
  root: string,
  task: string,
  machine: string,
  run: string
): Effect.Effect<Progress, TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const at = yield* nowIso
    const retried = yield* retryStartedTask(root, task, machine, run, at).pipe(
      Effect.catchTag("BacklogError", () => Effect.succeed(null))
    )
    if (retried === null) {
      return { kind: "untracked" } satisfies Progress
    }
    yield* recordEvent(root, { key: task + ".retry." + run, at, text: task + " will retry from run " + run + " on its kept branch" }).pipe(
      Effect.catchTag("BacklogError", () => Effect.void)
    )
    return { kind: "ended", action: { kind: "retry", task, machine, run } } satisfies Progress
  })

const closeOwnLogRun = (
  context: CloseContext,
  task: TaskRecord,
  machine: string,
  started: { readonly at: string; readonly log: string }
): Effect.Effect<Progress, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const silent = ownLogEndingOf(started.at, yield* logWrittenAt(started.log), Date.parse(yield* nowIso))
    if (silent === null) {
      return { kind: "own-log" } satisfies Progress
    }
    const silentEnded = yield* endTask(context.root, context.home, task, machine, silent)
    return Option.match(silentEnded, { onNone: (): Progress => ({ kind: "untracked" }), onSome: (action): Progress => ({ kind: "ended", action }) })
  })

export const closeFinished = (
  context: CloseContext,
  task: TaskRecord
): Effect.Effect<Progress, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (task.state.kind !== "started") {
      return { kind: "untracked" } satisfies Progress
    }
    const claim = task.state.claim
    const started = task.state.started
    const label = runLabel(context.home, task.spec.id, task.spec.kind)
    const machine = context.config.machines.find((entry) => entry.name === claim.machine)
    if (machine === undefined) {
      return { kind: "untracked" } satisfies Progress
    }
    if (!ownedBySweep(machine)) {
      return yield* closeOwnLogRun(context, task, claim.machine, started)
    }
    const through = throughFor(machine)
    const reading: CloseReading = yield* readClose(task, context.home, label, through)
    const { nowText, unreadSince } = yield* trackReading(context, task.spec.id, claim.machine, reading)
    const stale = staleEndingOf(started.at, Date.parse(nowText), reading, unreadSince)
    const ending = reading.kind === "read" ? (stale ?? reading.ending) : stale
    if (ending === null) {
      if (reading.kind === "unreached") {
        return { kind: "unknown" } satisfies Progress
      }
      if (reading.kind !== "read") {
        return { kind: "ended", action: { kind: "close-failed", task: task.spec.id, machine: claim.machine, reason: reading.reason } } satisfies Progress
      }
      const action = yield* serveRunning(context, task, claim.machine, through, label, reading.asking)
      return { kind: "running", outputAt: reading.outputAt, action, failing: reading.failing, ...(reading.result.run == null ? {} : { run: reading.result.run.id }) } satisfies Progress
    }
    const run = deadRunOf(reading)
    if (stale === null && ending.kind === "close" && ending.outcome === "failed" && task.retry === undefined && run !== undefined) {
      return yield* retryDeadRun(context.root, task.spec.id, claim.machine, run)
    }
    const ended = yield* endTask(context.root, context.home, task, claim.machine, ending, reading.kind === "read" ? reading.result.run?.id : undefined)
    return Option.match(ended, { onNone: (): Progress => ({ kind: "untracked" }), onSome: (action): Progress => ({ kind: "ended", action }) })
  }).pipe(
    Effect.tap((progress) => progress.kind === "ended" && (progress.action.kind === "retry" || progress.action.kind === "closed" || (progress.action.kind === "split" && task.spec.parent !== null))
      ? nowIso.pipe(Effect.flatMap((at) => withdrawTaskItems(context.root, [task.spec.id], at)))
      : Effect.void)
  )
