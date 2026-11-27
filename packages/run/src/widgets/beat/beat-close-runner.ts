import { Array as Arr, Duration, Effect } from "effect"
import type { BeatAction } from "../../entities/attention/index"
import type { FailingMark } from "../../entities/agent/index"
import type { TaskFileError, TaskRecord } from "../../entities/backlog/index"
import { answersFor, askStartedTask, correctionsDue, markAnswersRelayed, markCorrectionsQueued } from "../../entities/parked-runs/index"
import { type Asking, hasBlockingQuestion, type QuestionAnswer } from "../../entities/review-gate/index"
import { correctThrough, endingFromResult, type Relay, relayAnswers, relayAnswersThrough, type RunEnding, readResult, readResultReaching, type RunnerRequirements, type RunnerResult } from "../../features/queueing-a-task/index"
import type { Command, RunnerError } from "../../shared/process/index"

const closeSeconds = 30

export type CloseReading =
  | { readonly kind: "read"; readonly result: RunnerResult; readonly ending: RunEnding | null; readonly outputAt: string | null; readonly asking: typeof Asking.Type | null; readonly failing: FailingMark | null }
  | { readonly kind: "unread"; readonly reason: string }
  | { readonly kind: "unreached"; readonly reason: string }

const askingOf = (result: RunnerResult): typeof Asking.Type | null =>
  (result.status === "running" || result.status === "paused") && result.run?.asking !== undefined ? result.run.asking : null

const failingOf = (result: RunnerResult): FailingMark | null =>
  (result.status === "running" || result.status === "paused") && result.run?.failing !== undefined ? result.run.failing : null

// A blocking question makes silence an expected part of the run.
const outputAtOf = (result: RunnerResult): string | null => {
  const asking = askingOf(result)
  const blocking = asking !== null && hasBlockingQuestion(asking)
  return (result.status === "running" || result.status === "paused") && result.outputAt !== undefined && !blocking ? result.outputAt : null
}

const serveAsking = (
  root: string,
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
    const asked = yield* askStartedTask(root, id, live).pipe(Effect.catchTag("BacklogError", () => Effect.succeed(false)))
    if (asked) {
      return { kind: "asking", task: id, machine, until: asking.until, questions: asking.questions.map((question) => question.id) } satisfies BeatAction
    }
    const answered = answersFor(task, live)
    const fresh = answered.filter((question) => question.answer.relayedTo === null)
    if (fresh.length === 0) {
      return null
    }
    // Relaying only fresh answers would overwrite answers already delivered.
    return yield* relay({ asking: asking.asked, answers: answered.map((question) => ({ question: question.id, answer: question.answer.words, decider: question.answer.decider })) }).pipe(
      Effect.andThen(markAnswersRelayed(root, id, asking.asked, fresh.map((question) => ({ id: question.id, asked: question.asked, words: question.answer.words }))).pipe(
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
  return correct(due.map((question) => ({ question: question.id, answer: question.answer.words, decider: question.answer.decider }))).pipe(
    Effect.andThen(markCorrectionsQueued(root, id, due).pipe(Effect.catchTags({ BacklogError: () => Effect.void, TaskFileError: () => Effect.void }))),
    Effect.as<BeatAction>({ kind: "answer-failed", task: id, machine, reason: "the correction was queued, but delivery to the run is not confirmed" }),
    Effect.catchTag("RunnerError", (error) => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: error.detail })),
    Effect.timeoutOrElse({
      duration: Duration.seconds(closeSeconds),
      orElse: () => Effect.succeed<BeatAction>({ kind: "answer-failed", task: id, machine, reason: "the correction relay timed out after " + closeSeconds + " seconds" })
    })
  )
}

export const serveRunning = (
  context: { readonly root: string; readonly home: string },
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
    return (asking === null ? null : yield* serveAsking(context.root, task, machine, asking, relay)) ?? (yield* serveCorrections(context.root, task, machine, correct))
  })

export const readClose = (
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
