import { Data, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { bundledAgentsDir } from "../agents"
import { readItem, recordDecision, reviewQuestionId, routeReviewQuestions } from "./attention"
import { findTask } from "./backlog"
import type { BacklogError } from "./backlog-write"
import { answerTask } from "./parked"
import type { ParkedQuestion, TaskFileError, TaskRecord } from "./task-record"

export class DeciderUnheard extends Data.TaggedError("DeciderUnheard")<{
  readonly reason: string
}> {}

export interface DeciderRequest {
  readonly policy: string
  readonly prompt: string
}

export type AskDecider = (request: DeciderRequest) => Effect.Effect<string, DeciderUnheard, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>

const Words = Schema.String.check(Schema.isNonEmpty())

const Reply = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("answer"), answer: Words, reason: Words }),
  Schema.Struct({ decision: Schema.Literal("escalate"), reason: Words })
])

type Verdict = { readonly kind: "answered"; readonly words: string; readonly reason: string } | { readonly kind: "escalated"; readonly reason: string }

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))

// A model may wrap its JSON in prose or a fence, so the object is cut out of the reply before it is read.
const readReply = (text: string): Verdict => {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  return Option.match(decodeReply(json), {
    onNone: (): Verdict => ({ kind: "escalated", reason: "the decider's reply held no decision orc reads: " + text.trim().slice(0, 200) }),
    onSome: (reply): Verdict => reply.decision === "answer" ? { kind: "answered", words: reply.answer.trim(), reason: reply.reason } : { kind: "escalated", reason: reply.reason }
  })
}

const deciderPolicyFile = (): string => bundledAgentsDir() + "/decider-policy.md"

const deciderPrompt = (task: TaskRecord, question: ParkedQuestion): string =>
  "The intent of the task " + task.spec.id + ", " + task.spec.title + ":\n\n" + task.spec.body.trim() + "\n\nThe review question its run stopped on, " + question.id + ":\n\n" + question.text

export interface Decided {
  readonly item: string
  readonly task: string
  readonly verdict: Verdict
}

const askOne = (ask: AskDecider, policy: string, task: TaskRecord, question: ParkedQuestion) =>
  ask({ policy, prompt: deciderPrompt(task, question) }).pipe(
    Effect.map(readReply),
    Effect.catchTag("DeciderUnheard", (error) => Effect.succeed<Verdict>({ kind: "escalated", reason: "the decider was not heard: " + error.reason }))
  )

const settle = (root: string, task: TaskRecord, question: ParkedQuestion, item: string, verdict: Verdict, at: string) =>
  Effect.gen(function*() {
    if (verdict.kind === "escalated") {
      yield* recordDecision(root, item, { kind: "escalated", reason: verdict.reason, at })
      return verdict
    }
    const refused = yield* answerTask(root, task.spec.id, question.id + "=" + verdict.words, at).pipe(
      Effect.as(null),
      Effect.catchTags({ BacklogError: (error) => Effect.succeed(error.detail), TaskFileError: (error) => Effect.succeed(error.detail) })
    )
    if (refused !== null) {
      const escalated: Verdict = { kind: "escalated", reason: "the decider's answer did not reach the task: " + refused }
      yield* recordDecision(root, item, { kind: "escalated", reason: escalated.reason, at })
      return escalated
    }
    yield* recordDecision(root, item, { kind: "answered", reason: verdict.reason, at })
    yield* routeReviewQuestions(root, [yield* findTask(root, task.spec.id)], at)
    return verdict
  })

// Each open question the decider owns gets its own call, so one question's reply never answers another.
export const decideReviewQuestions = (
  root: string,
  tasks: ReadonlyArray<TaskRecord>,
  ask: AskDecider,
  at: string
): Effect.Effect<ReadonlyArray<Decided>, BacklogError | TaskFileError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const decided: Array<Decided> = []
    let policy: string | null = null
    for (const task of tasks) {
      if (task.state.kind === "closed") {
        continue
      }
      for (const question of task.parked?.questions ?? []) {
        const item = reviewQuestionId(task.spec.id, question.id, question.asked)
        const read = question.answer === null ? yield* readItem(root, item) : null
        if (read === null || read.state.kind !== "open" || read.owner !== "decider") {
          continue
        }
        policy ??= yield* fs.readFileString(deciderPolicyFile()).pipe(Effect.orElseSucceed(() => ""))
        const verdict = policy === ""
          ? { kind: "escalated" as const, reason: "orc cannot read the decider policy at " + deciderPolicyFile() }
          : yield* askOne(ask, policy, task, question)
        decided.push({ item, task: task.spec.id, verdict: yield* settle(root, task, question, item, verdict, at) })
      }
    }
    return decided
  })

export const decidedLine = (entry: Decided): string =>
  entry.verdict.kind === "answered"
    ? "answered " + entry.item + ": " + entry.verdict.words + " (" + entry.verdict.reason + ")"
    : "escalated " + entry.item + " to the user: " + entry.verdict.reason
