import { Array as Arr, DateTime, Duration, Effect, FileSystem, Option, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, type BacklogError, closeStartedTask, runLabel, runDirFor, taskBranch, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { type BeatAction, openUnreachedMachine, type Progress, withdrawTaskItems, withdrawUnreachedMachine } from "../../entities/attention/index"
import type { FailingMark } from "../../entities/agent/index"
import type { DispatchConfig } from "../../shared/config/index"
import { ownedBySweep, throughFor } from "../../shared/config/index"
import { logWrittenAt, stallMillis } from "./stall"
import { endSplit } from "./beat-split"
import { answersFor, askStartedTask, type AskedQuestion, correctionsDue, markAnswersRelayed, markCorrectionsQueued, parkStartedTask } from "../../entities/parked-runs/index"
import { Asking, askingFileName, hasBlockingQuestion, type QuestionAnswer } from "../../entities/review-gate/index"
import { readJsonFileIfPresent } from "../../shared/config/index"
import { type RunnerRequirements } from "../../features/queueing-a-task/index"
import { type RunnerError } from "../../shared/process/index"
import { type Command } from "../../shared/process/index"
import { correctThrough, endingFromResult, type Relay, relayAnswers, relayAnswersThrough, type RunEnding, readResult, readResultReaching, type RunnerResult } from "../../features/queueing-a-task/index"

export interface CloseContext {
  readonly root: string
  readonly home: string
  readonly config: DispatchConfig
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

const closeSeconds = 30

// The beat writes started before the runner queues, so a runner that still holds no record this long after the start never will.
const missingRunnerGraceMillis = 10 * 60 * 1000

type CloseReading =
  | { readonly kind: "read"; readonly result: RunnerResult; readonly ending: RunEnding | null; readonly outputAt: string | null; readonly asking: typeof Asking.Type | null; readonly failing: FailingMark | null }
  | { readonly kind: "unread"; readonly reason: string }
  | { readonly kind: "unreached"; readonly reason: string }

// A close read that stays unread past the queue delay releases the machine, measured from its first unread beat.
export const staleEndingOf = (startedAt: string, nowMillis: number, reading: CloseReading, unreadSinceMillis: number | null): RunEnding | null => {
  // The run lives on the machine orc cannot reach, so it may still be working or already done there.
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

// An own-log machine keeps its own record, so the sweep only ends its task when the log itself goes quiet past the stall window.
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
        Effect.orElseSucceed(() => [] as ReadonlyArray<AskedQuestion>)
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

const endTask = (
  root: string,
  home: string,
  task: TaskRecord,
  machine: string,
  ending: RunEnding,
  run?: string
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  ending.kind === "park" ? endParked(root, home, task, machine, ending, run) : ending.kind === "split" ? endSplit(root, task, machine, ending) : endClosed(root, task, machine, ending)

const askingOf = (result: RunnerResult): typeof Asking.Type | null =>
  (result.status === "running" || result.status === "paused") && result.run?.asking !== undefined ? result.run.asking : null

const failingOf = (result: RunnerResult): FailingMark | null =>
  (result.status === "running" || result.status === "paused") && result.run?.failing !== undefined ? result.run.failing : null

// A run waiting on the captain writes no output, and that silence is no stall.
const outputAtOf = (result: RunnerResult): string | null => {
  const asking = askingOf(result)
  const blocking = asking !== null && hasBlockingQuestion(asking)
  return (result.status === "running" || result.status === "paused") && result.outputAt !== undefined && !blocking ? result.outputAt : null
}

const serveAsking = (
  context: CloseContext,
  task: TaskRecord,
  machine: string,
  asking: typeof Asking.Type,
  relay: (relay: Relay) => Effect.Effect<string, RunnerError, RunnerRequirements>
): Effect.Effect<BeatAction | null, TaskFileError, RunnerRequirements> =>
  Effect.gen(function*() {
    const id = task.spec.id
    if (!Arr.isReadonlyArrayNonEmpty(asking.questions)) {
      return null
    }
    const live = { asked: asking.asked, questions: asking.questions }
    const asked = yield* askStartedTask(context.root, id, live).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(false)))
    if (asked) {
      return { kind: "asking", task: id, machine, until: asking.until, questions: asking.questions.map((question) => question.id) } satisfies BeatAction
    }
    const answered = answersFor(task, live)
    const fresh = answered.filter((question) => question.answer.relayedTo === null)
    if (fresh.length === 0) {
      return null
    }
    // answers.json is replaced whole, so each relay carries every answer of the asking and not only the new ones.
    return yield* relay({ asking: asking.asked, answers: answered.map((question) => ({ question: question.id, answer: question.answer.words })) }).pipe(
      Effect.andThen(markAnswersRelayed(context.root, id, asking.asked, fresh.map((question) => ({ id: question.id, asked: question.asked, words: question.answer.words }))).pipe(
        Effect.catchTag("BacklogError", () => Effect.void)
      )),
      Effect.as<BeatAction>({ kind: "answered", task: id, machine, questions: fresh.map((question) => question.id) }),
      Effect.catchTag("RunnerError", (error) => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: error.detail })),
      Effect.timeoutOrElse({
        duration: Duration.seconds(closeSeconds),
        orElse: () => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: "the answer relay timed out after " + closeSeconds + " seconds" })
      })
    )
  })

export const serveCorrections = (
  root: string,
  task: TaskRecord,
  machine: string,
  correct: (corrections: ReadonlyArray<QuestionAnswer>) => Effect.Effect<string, RunnerError, RunnerRequirements>
): Effect.Effect<BeatAction | null, never, RunnerRequirements> => {
  const due = correctionsDue(task)
  if (due.length === 0) {
    return Effect.succeed(null)
  }
  const id = task.spec.id
  return correct(due.map((question) => ({ question: question.id, answer: question.answer.words }))).pipe(
    Effect.andThen(markCorrectionsQueued(root, id, due).pipe(Effect.catchTags({ BacklogError: () => Effect.void, TaskFileError: () => Effect.void }))),
    Effect.as<BeatAction>({ kind: "answer-failed", task: id, machine, reason: "the correction was queued, but delivery to the run is not confirmed" }),
    Effect.catchTag("RunnerError", (error) => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: error.detail })),
    Effect.timeoutOrElse({
      duration: Duration.seconds(closeSeconds),
      orElse: () => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: "the correction relay timed out after " + closeSeconds + " seconds" })
    })
  )
}

const serveRunning = (
  context: CloseContext,
  task: TaskRecord,
  machine: string,
  through: Command | null,
  label: string,
  asking: typeof Asking.Type | null
): Effect.Effect<BeatAction | null, TaskFileError, RunnerRequirements> =>
  Effect.gen(function*() {
    const relay = (handed: Relay) =>
      through === null
        ? relayAnswers(context.home, task.spec.id, Effect.succeed(JSON.stringify({ label, asking: handed.asking, answers: handed.answers })))
        : relayAnswersThrough(through, task.spec.id, label, handed)
    const correct = (corrections: ReadonlyArray<QuestionAnswer>) =>
      through === null
        ? relayAnswers(context.home, task.spec.id, Effect.succeed(JSON.stringify({ label, corrections })))
        : correctThrough(through, task.spec.id, label, corrections)
    return (asking === null ? null : yield* serveAsking(context, task, machine, asking, relay)) ?? (yield* serveCorrections(context.root, task, machine, correct))
  })

const readClose = (
  task: TaskRecord,
  home: string,
  label: string,
  through: Command | null
): Effect.Effect<CloseReading, never, RunnerRequirements> =>
  (through === null ? readResult(task.spec.id, home, label) : readResultReaching(through, task.spec.id, label)).pipe(
    Effect.map((result): CloseReading => ({ kind: "read", result, ending: endingFromResult(result, task.spec.kind), outputAt: outputAtOf(result), asking: askingOf(result), failing: failingOf(result) })),
    Effect.catchTags({
      RunnerError: (error) => Effect.succeed<CloseReading>({ kind: "unread", reason: error.detail }),
      MachineUnreached: (error) => Effect.succeed<CloseReading>({ kind: "unreached", reason: error.detail })
    }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(closeSeconds),
      orElse: () => Effect.succeed<CloseReading>({ kind: through === null ? "unread" : "unreached", reason: "the close read timed out after " + closeSeconds + " seconds" })
    })
  )

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
    if (yield* fs.exists(unreachedFile).pipe(Effect.orElseSucceed(() => false))) {
      yield* clearSince(fs, unreachedFile)
      yield* withdrawUnreachedMachine(root, task, nowText)
    }
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

// A finished run ends its task here, because no other beat step reads a started task after its run ends.
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
    const fs = yield* FileSystem.FileSystem
    const unreadFile = backlogPaths(context.root).unreadFile(task.spec.id)
    const nowText = yield* nowIso
    const unreadSince = reading.kind === "unread"
      ? yield* readSince(fs, unreadFile, nowText)
      : yield* clearSince(fs, unreadFile)
    yield* trackUnreached(context.root, task.spec.id, claim.machine, reading, fs, nowText)
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
      return { kind: "running", outputAt: reading.outputAt, action, failing: reading.failing } satisfies Progress
    }
    const ended = yield* endTask(context.root, context.home, task, claim.machine, ending, reading.kind === "read" ? reading.result.run?.id : undefined)
    return Option.match(ended, { onNone: (): Progress => ({ kind: "untracked" }), onSome: (action): Progress => ({ kind: "ended", action }) })
  }).pipe(
    Effect.tap((progress) => progress.kind === "ended" && (progress.action.kind === "closed" || (progress.action.kind === "split" && task.spec.parent !== null))
      ? nowIso.pipe(Effect.flatMap((at) => withdrawTaskItems(context.root, [task.spec.id], at)))
      : Effect.void)
  )
