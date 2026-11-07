import { Array as Arr, DateTime, Duration, Effect, type FileSystem, Option, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { closeStartedTask } from "./backlog"
import type { BeatAction } from "./beat-action"
import type { DispatchConfig } from "./config"
import { ownedBySweep, throughFor } from "./machine-reach"
import type { QuestionAnswer } from "../no-mistakes-gate"
import { askStartedTask, parkStartedTask } from "./parked"
import { taskLabel } from "./pueue-status"
import { type RunnerError, type RunnerRequirements, taskBranch } from "./runner"
import { endingFromResult, relayAnswers, relayAnswersThrough, type RunEnding, readResult, readResultThrough, type RunnerResult } from "./runner-result"
import type { TaskFileError, TaskRecord } from "./task-record"

export interface CloseContext {
  readonly root: string
  readonly home: string
  readonly config: DispatchConfig
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))

const closeSeconds = 30

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
      const parked = yield* parkStartedTask(root, id, branch, ending.questions).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(null)))
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
  relay: (answers: ReadonlyArray<QuestionAnswer>) => Effect.Effect<string, RunnerError, RunnerRequirements>
): Effect.Effect<BeatAction | null, TaskFileError, RunnerRequirements> =>
  Effect.gen(function*() {
    const id = task.spec.id
    if (!Arr.isReadonlyArrayNonEmpty(asking.questions)) {
      return null
    }
    const asked = yield* askStartedTask(context.root, id, asking.questions).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(false)))
    if (asked) {
      return { kind: "asking", task: id, machine, until: asking.until, questions: asking.questions.map((question) => question.id) } satisfies BeatAction
    }
    const answers = (task.parked?.questions ?? []).flatMap((question) =>
      question.answer !== null && asking.questions.some((open) => open.id === question.id) ? [{ question: question.id, answer: question.answer.words }] : []
    )
    if (answers.length === 0) {
      return null
    }
    return yield* relay(answers).pipe(
      Effect.as<BeatAction>({ kind: "answered", task: id, machine, questions: answers.map((entry) => entry.question) }),
      Effect.catchTag("RunnerError", (error) => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: error.detail }))
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
    const label = taskLabel(context.home, task.spec.id)
    const machine = context.config.machines.find((entry) => entry.name === claim.machine)
    if (machine === undefined) {
      return { kind: "untracked" } satisfies Progress
    }
    if (!ownedBySweep(machine)) {
      return { kind: "own-log" } satisfies Progress
    }
    const through = throughFor(machine)
    const read = through === null ? readResult(task.spec.id, context.home, label) : readResultThrough(through, task.spec.id, label)
    const outcome = yield* read.pipe(
      Effect.map((result) => ({ kind: "read" as const, ending: endingFromResult(result, task.spec.kind), outputAt: outputAtOf(result), asking: askingOf(result) })),
      Effect.catchTag("RunnerError", (error) => Effect.succeed({ kind: "unread" as const, reason: error.detail })),
      Effect.timeoutOrElse({
        duration: Duration.seconds(closeSeconds),
        orElse: () => Effect.succeed({ kind: "unread" as const, reason: "the close read timed out after " + closeSeconds + " seconds" })
      })
    )
    if (outcome.kind === "unread") {
      return { kind: "ended", action: { kind: "close-failed", task: task.spec.id, machine: claim.machine, reason: outcome.reason } } satisfies Progress
    }
    if (outcome.ending === null) {
      const relay = (answers: ReadonlyArray<QuestionAnswer>) =>
        through === null ? relayAnswers(context.home, task.spec.id, Effect.succeed(JSON.stringify({ label, answers }))) : relayAnswersThrough(through, task.spec.id, label, answers)
      const action = outcome.asking === null ? null : yield* serveAsking(context, task, claim.machine, outcome.asking, relay)
      return { kind: "running", outputAt: outcome.outputAt, action } satisfies Progress
    }
    const ended = yield* endTask(context.root, task, claim.machine, outcome.ending)
    return Option.match(ended, { onNone: (): Progress => ({ kind: "untracked" }), onSome: (action): Progress => ({ kind: "ended", action }) })
  })
