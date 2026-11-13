import { Duration, Effect, type FileSystem, Option, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, taskPr, type TaskRecord } from "../../entities/backlog/index"
import type { BeatAction, StalledAction } from "../../entities/attention/index"
import type { ChatEvent } from "../../entities/events/index"
import { routePullRequest } from "../../entities/attention/index"
import { eventRecorded, readPrState, recordEvent, writePrState } from "../../entities/events/index"
import { checkRefusals, greenChecks, type PullRequestView } from "../../entities/pull-request/index"
import type { RunnerError } from "../../shared/process/index"

export type ReadPullRequest = (url: string) => Effect.Effect<PullRequestView, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner>

type Requirements = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

const prSeconds = 30

const named = (task: TaskRecord): string => task.spec.id + " " + task.spec.title

export const stallEvent = (root: string, task: TaskRecord, stall: StalledAction, at: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  recordEvent(root, {
    key: task.spec.id + ".stalled." + String(Date.parse(stall.since)),
    at,
    text: named(task) + " stalled on " + stall.machine + ": no output since " + stall.since
  })


const prEvent = (task: TaskRecord, pr: string, view: PullRequestView, at: string, readyPosted: boolean): ChatEvent | null => {
  if (view.state === "MERGED") {
    return { key: task.spec.id + ".merged", at, text: named(task) + " merged: " + pr }
  }
  if (view.state === "CLOSED") {
    return { key: task.spec.id + ".pr-closed", at, text: named(task) + " PR closed without merging: " + pr }
  }
  if (readyPosted || checkRefusals(view).length > 0) {
    return null
  }
  return { key: task.spec.id + ".pr-ready", at, text: named(task) + " PR ready: " + pr + ", checks green: " + greenChecks(view).join(", ") }
}

export const prEvents = (
  root: string,
  task: TaskRecord,
  read: ReadPullRequest,
  at: string
): Effect.Effect<Option.Option<BeatAction>, BacklogError, Requirements> =>
  Effect.gen(function*() {
    const pr = taskPr(task)
    const id = task.spec.id
    if (pr === null) {
      return Option.none()
    }
    const recorded = yield* readPrState(root, id, pr)
    if (recorded === "merged" || recorded === "closed") {
      return Option.none()
    }
    const view = yield* read(pr).pipe(Effect.result, Effect.timeoutOrElse({ duration: Duration.seconds(prSeconds), orElse: () => Effect.succeed(Result.fail(new BacklogError({ detail: "cannot read " + pr + ": the read timed out after " + prSeconds + " seconds" }))) }))
    if (Result.isFailure(view)) {
      return Option.some<BeatAction>({ kind: "pr-unread", task: id, reason: view.failure.detail })
    }
    const state = view.success.state
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
      return Option.some<BeatAction>({ kind: "pr-unread", task: id, reason: "unknown PR state " + state })
    }
    const prState = state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "merged"
    if (task.spec.kind !== "ship") {
      yield* writePrState(root, id, pr, prState)
      return Option.none()
    }
    yield* routePullRequest(root, id, pr, view.success, at)
    const event = prEvent(task, pr, view.success, at, yield* eventRecorded(root, id + ".pr-ready"))
    if (event !== null) {
      yield* recordEvent(root, event)
    }
    yield* writePrState(root, id, pr, prState)
    return Option.none()
  })
