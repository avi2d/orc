import { Array as Arr, DateTime, Duration, Effect, FileSystem, Option, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths, closeStartedTask, findTask, listTasks, applyRunSplit, splitEventText, runLabel, taskBranch, type TaskFileError, type TaskRecord } from "../entities/backlog/index"
import { recordEvent } from "../entities/events/index"
import type { BeatAction, Progress } from "../entities/attention/index"
import type { DispatchConfig } from "../shared/config/index"
import { ownedBySweep, throughFor } from "../shared/config/index"
import { logWrittenAt, stallMillis } from "./stall"
import { answersFor, askStartedTask, markAnswersRelayed, parkStartedTask } from "./parked"
import { type RunnerRequirements } from "./runner"
import { type RunnerError } from "../shared/process/index"
import { type Command } from "../shared/process/index"
import { endingFromResult, type Relay, relayAnswers, relayAnswersThrough, type RunEnding, readResult, readResultThrough, type RunnerResult } from "./runner-result"

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

// A close read that stays unread past the queue delay releases the machine, measured from its first unread beat.
export const staleEndingOf = (startedAt: string, nowMillis: number, reading: CloseReading, unreadSinceMillis: number | null): RunEnding | null => {
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
type SplitEnding = Extract<RunEnding, { readonly kind: "split" }>
type CloseEnding = Extract<RunEnding, { readonly kind: "close" }>

const endParked = (
  root: string,
  task: TaskRecord,
  machine: string,
  ending: ParkEnding
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    const branch = task.parked?.branch ?? taskBranch(id)
    const parked = yield* parkStartedTask(root, id, branch, ending.questions, yield* nowIso).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(null)))
    return parked === null
      ? Option.none()
      : Option.some({ kind: "parked", task: id, machine, branch, questions: ending.questions.map((question) => question.id), decider: [] } satisfies BeatAction)
  })

const childIdsOf = (tasks: ReadonlyArray<TaskRecord>, parent: string): ReadonlyArray<string> =>
  tasks.filter((candidate) => candidate.spec.parent === parent).map((candidate) => candidate.spec.id)

const siblingIdsOf = (tasks: ReadonlyArray<TaskRecord>, parent: string, created: string): ReadonlyArray<string> =>
  tasks.filter((candidate) => candidate.spec.parent === parent && candidate.spec.created === created).map((candidate) => candidate.spec.id)

const splitFailureText = (id: string, children: ReadonlyArray<string>, detail: string): string =>
  "split " + id + " into " + (children.length === 0 ? "no children" : children.join(", ")) + " failed: " + detail

const listTasksOrEmpty = (root: string): Effect.Effect<ReadonlyArray<TaskRecord>, never, FileSystem.FileSystem> =>
  listTasks(root).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TaskRecord>))

const endSplitParentFailure = (
  root: string,
  id: string,
  machine: string,
  detail: string
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const children = childIdsOf(yield* listTasksOrEmpty(root), id)
    return Option.some({ kind: "close-failed", task: id, machine, reason: splitFailureText(id, children, detail) } satisfies BeatAction)
  })

const endSplitFailure = (
  root: string,
  task: TaskRecord,
  machine: string,
  detail: string,
  at: string
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    const reopened = yield* findTask(root, id).pipe(Effect.orElseSucceed(() => null))
    if (reopened !== null && reopened.state.kind === "new" && reopened.spec.kind === "parent") {
      return yield* endSplitParentFailure(root, id, machine, detail)
    }
    const parent = task.spec.parent
    if (parent === null || reopened === null) {
      return Option.none()
    }
    const created = siblingIdsOf(yield* listTasksOrEmpty(root), parent, at)
    const reason = splitFailureText(id, created, detail)
    const closed = yield* closeStartedTask(root, id, "failed", reason, { pr: null, report: null }, at).pipe(
      Effect.catchTag("BacklogError", () => Effect.succeed(null))
    )
    return closed === null || closed.state.kind !== "closed"
      ? Option.none()
      : Option.some({ kind: "closed", task: id, machine, outcome: "failed", reason: closed.state.closing.reason, pr: null, report: null } satisfies BeatAction)
  })

const endSplit = (
  root: string,
  task: TaskRecord,
  machine: string,
  ending: SplitEnding
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const id = task.spec.id
    const at = yield* nowIso
    const applied = yield* applyRunSplit(root, task, ending.plan, at).pipe(
      Effect.map((value) => ({ kind: "applied" as const, value })),
      Effect.catchTags({
        BacklogError: (error) => Effect.succeed({ kind: "failed" as const, detail: error.detail }),
        TaskFileError: (error) => Effect.succeed({ kind: "failed" as const, detail: error.detail })
      })
    )
    if (applied.kind === "applied") {
      const reason = ending.plan.reason.trim()
      yield* recordEvent(root, { key: id + ".split", at, text: splitEventText(applied.value, "run", reason) }).pipe(Effect.catchTag("BacklogError", () => Effect.void))
      return Option.some({ kind: "split", task: id, machine, children: applied.value.children.map((child) => child.spec.id), reason } satisfies BeatAction)
    }
    return yield* endSplitFailure(root, task, machine, applied.detail, at)
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
  task: TaskRecord,
  machine: string,
  ending: RunEnding
): Effect.Effect<Option.Option<BeatAction>, TaskFileError, FileSystem.FileSystem> =>
  ending.kind === "park" ? endParked(root, task, machine, ending) : ending.kind === "split" ? endSplit(root, task, machine, ending) : endClosed(root, task, machine, ending)

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

const readClose = (
  task: TaskRecord,
  home: string,
  label: string,
  through: Command | null
): Effect.Effect<CloseReading, never, RunnerRequirements> =>
  (through === null ? readResult(task.spec.id, home, label) : readResultThrough(through, task.spec.id, label)).pipe(
    Effect.map((result) => ({ kind: "read" as const, result, ending: endingFromResult(result, task.spec.kind), outputAt: outputAtOf(result), asking: askingOf(result) })),
    Effect.catchTag("RunnerError", (error) => Effect.succeed({ kind: "unread" as const, reason: error.detail })),
    Effect.timeoutOrElse({
      duration: Duration.seconds(closeSeconds),
      orElse: () => Effect.succeed({ kind: "unread" as const, reason: "the close read timed out after " + closeSeconds + " seconds" })
    })
  )

const readUnreadSince = (
  fs: FileSystem.FileSystem,
  unreadFile: string,
  nowText: string
): Effect.Effect<number | null> =>
  fs.readFileString(unreadFile).pipe(
    Effect.map((text) => Date.parse(text)),
    Effect.catchTag("PlatformError", () => Effect.succeed<number | null>(null)),
    Effect.flatMap((parsed) =>
      parsed === null || Number.isNaN(parsed)
        ? fs.writeFileString(unreadFile, nowText).pipe(
          Effect.as<number | null>(null),
          Effect.catchTag("PlatformError", () => Effect.succeed<number | null>(null))
        )
        : Effect.succeed<number | null>(parsed)
    )
  )

const clearUnread = (
  fs: FileSystem.FileSystem,
  unreadFile: string
): Effect.Effect<number | null> =>
  fs.remove(unreadFile, { force: true }).pipe(
    Effect.as<number | null>(null),
    Effect.catchTag("PlatformError", () => Effect.succeed<number | null>(null))
  )

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
    const label = runLabel(context.home, task.spec.id, task.spec.kind)
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
    const reading: CloseReading = yield* readClose(task, context.home, label, through)
    const fs = yield* FileSystem.FileSystem
    const unreadFile = backlogPaths(context.root).unreadFile(task.spec.id)
    const nowText = yield* nowIso
    const unreadSince = reading.kind === "unread"
      ? yield* readUnreadSince(fs, unreadFile, nowText)
      : yield* clearUnread(fs, unreadFile)
    const stale = staleEndingOf(started.at, Date.parse(nowText), reading, unreadSince)
    const ending = reading.kind === "read" ? (stale ?? reading.ending) : stale
    if (ending === null) {
      if (reading.kind === "unread") {
        return { kind: "ended", action: { kind: "close-failed", task: task.spec.id, machine: claim.machine, reason: reading.reason } } satisfies Progress
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
