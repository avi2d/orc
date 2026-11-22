import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { AnswersFile, answersFileName, CorrectionsFile, correctionsFileName, type QuestionAnswer } from "../../entities/review-gate/index"
import { readJsonFileIfPresent, writeWhole } from "../../shared/config/index"
import { runDirFor } from "../../entities/backlog/index"
import { LabelArg } from "../../entities/token/index"
import { capture, type Command, decodeJson, type RunnerError } from "../../shared/process/index"
import { refuse, type RunnerRequirements } from "./runner"
import { readResult } from "./runner-result"

const AnswerStdin = Schema.Union([
  Schema.Struct({ ...AnswersFile.fields, label: Schema.optional(LabelArg) }),
  Schema.Struct({ ...CorrectionsFile.fields, label: Schema.optional(LabelArg) })
])

export interface Relay {
  readonly asking: string
  readonly answers: ReadonlyArray<QuestionAnswer>
}

const relayInto = (home: string, task: string, label: string | null, relay: Relay): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const result = yield* readResult(task, home, label)
    const run = result.status === "unknown" ? null : result.run
    if (run === null || run.asking === undefined) {
      return yield* refuse("no run of " + task + " waits for an answer")
    }
    if (run.asking.asked !== relay.asking) {
      return yield* refuse("run " + run.id + " of " + task + " no longer waits on the asking of " + relay.asking + ", it waits on the asking of " + run.asking.asked)
    }
    const file = runDirFor(home, run.id) + "/" + answersFileName
    if (!(yield* writeWhole(file, JSON.stringify({ asking: relay.asking, answers: relay.answers })))) {
      return yield* refuse("cannot write " + file)
    }
    return "handed " + relay.answers.map((entry) => entry.question).join(", ") + " to run " + run.id + " of " + task
  })

// The run asks nothing once it has its answer, so a correction goes to the run that is running rather than to an asking.
const correctInto = (home: string, task: string, label: string | null, corrections: ReadonlyArray<QuestionAnswer>): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const result = yield* readResult(task, home, label)
    const run = result.status === "running" || result.status === "paused" ? result.run : null
    if (run === null) {
      return yield* refuse("no run of " + task + " is running to take a corrected answer")
    }
    const file = runDirFor(home, run.id) + "/" + correctionsFileName
    const stored = yield* readJsonFileIfPresent(file, CorrectionsFile).pipe(Effect.orElseSucceed(() => null))
    const kept = (stored?.corrections ?? []).filter((entry) => !corrections.some((correction) => correction.question === entry.question))
    if (!(yield* writeWhole(file, JSON.stringify({ corrections: [...kept, ...corrections] })))) {
      return yield* refuse("cannot write " + file)
    }
    return "queued corrections for " + corrections.map((entry) => entry.question).join(", ") + " for run " + run.id + " of " + task + "; delivery is not confirmed"
  })

export const relayAnswers = (home: string, task: string, stdin: Effect.Effect<string, RunnerError>): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  stdin.pipe(
    Effect.flatMap((text) => decodeJson(text, AnswerStdin, "the answers on stdin")),
    Effect.flatMap((request) =>
      "corrections" in request
        ? correctInto(home, task, request.label ?? null, request.corrections)
        : relayInto(home, task, request.label ?? null, request))
  )

// The answers travel on stdin, so a reach that joins its argv for a remote shell cannot split the captain's words.
const answerThrough = (command: Command, task: string, label: string | null, body: object): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture([...command, "runner", "answer", task], JSON.stringify({ ...(label === null ? {} : { label }), ...body })).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : refuse(command.join(" ") + " runner answer exited " + result.exitCode + ": " + result.stderr.trim())
    )
  )

export const correctThrough = (command: Command, task: string, label: string | null, corrections: ReadonlyArray<QuestionAnswer>): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  answerThrough(command, task, label, { corrections })

export const relayAnswersThrough = (command: Command, task: string, label: string | null, relay: Relay): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  answerThrough(command, task, label, { asking: relay.asking, answers: relay.answers })
