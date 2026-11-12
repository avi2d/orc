import { Data, DateTime, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { bundledAgentsDir } from "../agents"
import { claimDeciding, openItems, recordDecision, reviewQuestionId, routeTaskItems } from "./attention"
import { findTask, type BacklogError, type ParkedQuestion, type TaskFileError, type TaskRecord } from "../entities/backlog/index"
import { answerTask } from "./parked"

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
    yield* recordDecision(root, item, { kind: "answered", reason: verdict.reason, at })
    const refused = yield* answerTask(root, task.spec.id, question.id + "=" + verdict.words, at).pipe(
      Effect.as(null),
      Effect.catchTags({ BacklogError: (error) => Effect.succeed(error.detail), TaskFileError: (error) => Effect.succeed(error.detail) })
    )
    if (refused === null) {
      yield* routeTaskItems(root, [yield* findTask(root, task.spec.id)], at)
      return verdict
    }
    const fresh = yield* findTask(root, task.spec.id)
    const stored = fresh.parked?.questions.find((candidate) => candidate.id === question.id)?.answer
    if (stored !== null && stored !== undefined) {
      yield* routeTaskItems(root, [fresh], at)
      return { kind: "answered", words: stored.words, reason: verdict.reason } satisfies Verdict
    }
    const escalated: Verdict = { kind: "escalated", reason: "the decider's answer did not reach the task: " + refused }
    yield* recordDecision(root, item, { kind: "escalated", reason: escalated.reason, at })
    return escalated
  })

// Each open question the decider owns gets its own call, so one question's reply never answers another.
export const decideReviewQuestions = (
  root: string,
  tasks: ReadonlyArray<TaskRecord>,
  ask: AskDecider
): Effect.Effect<ReadonlyArray<Decided>, BacklogError | TaskFileError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const decided: Array<Decided> = []
    let policy: string | null = null
    const byId = new Map(tasks.map((task) => [task.spec.id, task] as const))
    for (const entry of yield* openItems(root)) {
      if (entry.item.owner !== "decider") {
        continue
      }
      const task = byId.get(entry.item.task)
      if (task === undefined || task.state.kind === "closed") {
        continue
      }
      const question = task.parked?.questions.find((candidate) => reviewQuestionId(task.spec.id, candidate.id, candidate.asked) === entry.id)
      if (question === undefined || question.answer !== null) {
        continue
      }
      if (!(yield* claimDeciding(root, entry.id, DateTime.formatIso(yield* DateTime.now)))) {
        continue
      }
      policy ??= yield* fs.readFileString(deciderPolicyFile()).pipe(Effect.orElseSucceed(() => ""))
      const verdict = policy === ""
        ? { kind: "escalated" as const, reason: "orc cannot read the decider policy at " + deciderPolicyFile() }
        : yield* askOne(ask, policy, task, question)
      decided.push({ item: entry.id, task: task.spec.id, verdict: yield* settle(root, task, question, entry.id, verdict, DateTime.formatIso(yield* DateTime.now)) })
    }
    return decided
  })
