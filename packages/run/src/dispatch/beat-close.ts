import { Array as Arr, DateTime, Duration, Effect, type FileSystem, Option, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { closeStartedTask } from "./backlog"
import type { BeatAction } from "./beat-action"
import type { DispatchConfig } from "./config"
import { ownedBySweep, throughFor } from "./machine-reach"
import { logWrittenAt, stallMillis } from "./stall"
import { answersFor, askStartedTask, markAnswersRelayed, parkStartedTask } from "./parked"
import { taskLabel } from "./pueue-status"
import { type RunnerError, type RunnerRequirements, taskBranch } from "./runner"
import { endingFromResult, type Relay, relayAnswers, relayAnswersThrough, type RunEnding, readResult, readResultThrough, type RunnerResult } from "./runner-result"
import type { TaskFileError, TaskRecord } from "./task-record"

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
  | { readonly kind: "read"; readonly result: RunnerResult; readonly ending: RunEnding | null; readonly outputAt: string | null; readonly asking: Asking | null }
  | { readonly kind: "unread"; readonly reason: string }

// A task the runner cannot see and a close read that keeps failing both release the machine once the start outgrows the queue delay.
export const staleEndingOf = (startedAt: string, nowMillis: number, reading: CloseReading): RunEnding | null => {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started) || nowMillis - started <= missingRunnerGraceMillis) {
    return null
  }
  if (reading.kind === "unread") {
    return { kind: "close", outcome: "failed", reason: reading.reason, pr: null, report: null }
  }
  return reading.ending === null && reading.result.status === "unknown"
    ? { kind: "close", outcome: "failed", reason: "the runner holds no record of this task", pr: null, report: null }
    : reading.ending
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
  return { kind: "close", outcome: "failed", reason: "the machine keeps its own log, and the log shows no run output", pr: null, report: null }
}

const endTask = (
  root: string,
  task: TaskRecord,
  machine: string,
  ending: RunEnding
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    if (ending.kind === "park") {
      const branch = task.parked?.branch ?? taskBranch(id)
      const parked = yield* parkStartedTask(root, id, branch, ending.questions, yield* nowIso).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(null)))
      return parked === null
        ? Option.none()
        : Option.some({ kind: "parked", task: id, machine, branch, questions: ending.questions.map((question) => question.id) } satisfies BeatAction)
    }
    const closed = yield* closeStartedTask(root, id, ending.outcome, ending.reason, { pr: ending.pr, report: ending.report }, yield* nowIso).pipe(
      Effect.catchTag("BacklogError", () => Effect.succeed(null))
    )
    return closed === null
      ? Option.none()
      : Option.some({ kind: "closed", task: id, machine, outcome: ending.outcome, reason: ending.reason, pr: ending.pr, report: ending.report } satisfies BeatAction)
  })

export type Progress =
  | { readonly kind: "ended"; readonly action: BeatAction }
  | { readonly kind: "running"; readonly outputAt: string | null; readonly action: BeatAction | null }
  | { readonly kind: "own-log" }
  | { readonly kind: "untracked" }

type Asking = NonNullable<NonNullable<Extract<RunnerResult, { readonly status: "running" | "paused" }>["run"]>["asking"]>

const askingOf = (result: RunnerResult): Asking | null =>
  (result.status === "running" || result.status === "paused") && result.run?.asking !== undefined ? result.run.asking : null

// A run waiting on the captain writes no output, and that silence is no stall.
const outputAtOf = (result: RunnerResult): string | null =>
  (result.status === "running" || result.status === "paused") && result.outputAt !== undefined && askingOf(result) === null ? result.outputAt : null

const serveAsking = (
  context: CloseContext,
  task: TaskRecord,
  machine: string,
  asking: Asking,
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
    const fresh = answered.filter((question) => question.answer.relayedTo === null).map((question) => question.id)
    if (fresh.length === 0) {
      return null
    }
    // answers.json is replaced whole, so each relay carries every answer of the asking and not only the new ones.
    return yield* relay({ asking: asking.asked, answers: answered.map((question) => ({ question: question.id, answer: question.answer.words })) }).pipe(
      Effect.andThen(markAnswersRelayed(context.root, id, asking.asked, fresh).pipe(
        Effect.catchTag("BacklogError", () => Effect.void)
      )),
      Effect.as<BeatAction>({ kind: "answered", task: id, machine, questions: fresh }),
      Effect.catchTag("RunnerError", (error) => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: error.detail })),
      Effect.timeoutOrElse({
        duration: Duration.seconds(closeSeconds),
        orElse: () => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: "the answer relay timed out after " + closeSeconds + " seconds" })
      })
    )
  })

// A finished run ends its task here, because no other beat step reads a started task after its run ends.
export const closeFinished = (
  context: CloseContext,
  task: TaskRecord
): Effect.Effect<Progress, TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (task.state.kind !== "started") {
      return { kind: "untracked" } satisfies Progress
    }
    const claim = task.state.claim
    const started = task.state.started
    const label = taskLabel(context.home, task.spec.id)
    const machine = context.config.machines.find((entry) => entry.name === claim.machine)
    if (machine === undefined) {
      return { kind: "untracked" } satisfies Progress
    }
    if (!ownedBySweep(machine)) {
      const silent = ownLogEndingOf(started.at, yield* logWrittenAt(started.log), Date.parse(yield* nowIso))
      if (silent === null) {
        return { kind: "own-log" } satisfies Progress
      }
      const silentEnded = yield* endTask(context.root, task, claim.machine, silent)
      return Option.match(silentEnded, { onNone: (): Progress => ({ kind: "untracked" }), onSome: (action): Progress => ({ kind: "ended", action }) })
    }
    const through = throughFor(machine)
    const read = through === null ? readResult(task.spec.id, context.home, label) : readResultThrough(through, task.spec.id, label)
    const reading: CloseReading = yield* read.pipe(
      Effect.map((result) => ({ kind: "read" as const, result, ending: endingFromResult(result, task.spec.kind), outputAt: outputAtOf(result), asking: askingOf(result) })),
      Effect.catchTag("RunnerError", (error) => Effect.succeed({ kind: "unread" as const, reason: error.detail })),
      Effect.timeoutOrElse({
        duration: Duration.seconds(closeSeconds),
        orElse: () => Effect.succeed({ kind: "unread" as const, reason: "the close read timed out after " + closeSeconds + " seconds" })
      })
    )
    const stale = staleEndingOf(started.at, Date.parse(yield* nowIso), reading)
    if (reading.kind === "unread" && stale === null) {
      return { kind: "ended", action: { kind: "close-failed", task: task.spec.id, machine: claim.machine, reason: reading.reason } } satisfies Progress
    }
    const ending = stale ?? (reading.kind === "read" ? reading.ending : null)
    if (ending === null) {
      if (reading.kind === "unread") {
        return { kind: "untracked" } satisfies Progress
      }
      const relay = (handed: Relay) =>
        through === null
          ? relayAnswers(context.home, task.spec.id, Effect.succeed(JSON.stringify({ label, asking: handed.asking, answers: handed.answers })))
          : relayAnswersThrough(through, task.spec.id, label, handed)
      const action = reading.asking === null ? null : yield* serveAsking(context, task, claim.machine, reading.asking, relay)
      return { kind: "running", outputAt: reading.outputAt, action } satisfies Progress
    }
    const ended = yield* endTask(context.root, task, claim.machine, ending)
    return Option.match(ended, { onNone: (): Progress => ({ kind: "untracked" }), onSome: (action): Progress => ({ kind: "ended", action }) })
  })
