import { Duration, Effect, type FileSystem, Option, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError } from "./backlog-write"
import type { BeatAction, StalledAction } from "./beat-action"
import type { ChatEvent } from "./chat-event"
import { eventRecorded, recordEvent } from "./events"
import { checkRefusals, greenChecks, type PullRequestView } from "./pr-view"
import type { RunnerError } from "./runner"
import type { TaskRecord } from "./task-record"

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

const openPr = (task: TaskRecord): string | null =>
  task.state.kind === "closed" && task.state.closing.outcome !== "start-failed" && task.spec.kind === "ship" ? task.state.closing.pr : null

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

// A merged or closed PR changes no more, so its task's PR is read no more.
export const prEvents = (
  root: string,
  task: TaskRecord,
  read: ReadPullRequest,
  at: string
): Effect.Effect<Option.Option<BeatAction>, BacklogError, Requirements> =>
  Effect.gen(function*() {
    const pr = openPr(task)
    const id = task.spec.id
    if (pr === null || (yield* eventRecorded(root, id + ".merged")) || (yield* eventRecorded(root, id + ".pr-closed"))) {
      return Option.none()
    }
    const view = yield* read(pr).pipe(Effect.result, Effect.timeoutOrElse({ duration: Duration.seconds(prSeconds), orElse: () => Effect.succeed(Result.fail(new BacklogError({ detail: "cannot read " + pr + ": the read timed out after " + prSeconds + " seconds" }))) }))
    if (Result.isFailure(view)) {
      return Option.some<BeatAction>({ kind: "pr-unread", task: id, reason: view.failure.detail })
    }
    const event = prEvent(task, pr, view.success, at, yield* eventRecorded(root, id + ".pr-ready"))
    if (event !== null) {
      yield* recordEvent(root, event)
    }
    return Option.none()
  })
