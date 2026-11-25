import { Duration, Effect, type FileSystem, Option, type Path, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, ranClosing, taskPr, type TaskRecord } from "../../entities/backlog/index"
import type { BeatAction, StalledAction } from "../../entities/attention/index"
import type { ChatEvent, PrState } from "../../entities/events/index"
import { pullRequestHeld, routePullRequest } from "../../entities/attention/index"
import { eventRecorded, readPrState, recordEvent, writePrState } from "../../entities/events/index"
import { checkRefusals, greenChecks, redCheckEvidence, type PullRequestView } from "../../entities/pull-request/index"
import type { RunnerError } from "../../shared/process/index"
import { isPendingUpdateHead, readPendingUpdate } from "../../features/merging-a-pr/index"
import { sendBack } from "../../features/queueing-a-task/index"
import { ownerWaits, yoloMerge } from "./yolo-merge"

export type ReadPullRequest = (url: string) => Effect.Effect<PullRequestView, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner>

type Requirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

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

export const taskPrState = (root: string, task: TaskRecord): Effect.Effect<PrState | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const pr = taskPr(task)
    if (pr === null) {
      return null
    }
    if (yield* eventRecorded(root, task.spec.id + ".merged")) {
      return "merged"
    }
    if (yield* eventRecorded(root, task.spec.id + ".pr-closed")) {
      return "closed"
    }
    return yield* readPrState(root, task.spec.id, pr)
  })

const readPrView = (pr: string, read: ReadPullRequest) =>
  read(pr).pipe(Effect.result, Effect.timeoutOrElse({ duration: Duration.seconds(prSeconds), orElse: () => Effect.succeed(Result.fail(new BacklogError({ detail: "cannot read " + pr + ": the read timed out after " + prSeconds + " seconds" }))) }))

const readWaits = (pr: string, view: PullRequestView, yolo: boolean) =>
  Effect.result(ownerWaits(pr, view, yolo)).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(prSeconds), orElse: () => Effect.succeed(Result.fail(new BacklogError({ detail: "cannot read the files of " + pr + ": the read timed out after " + prSeconds + " seconds" }))) }))

const mergeTimed = (root: string, id: string, pr: string, home: string) =>
  yoloMerge(root, id, pr, home).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(prSeconds), orElse: () => Effect.succeed<BeatAction>({ kind: "merge-refused", task: id, reason: "cannot merge " + pr + ": the merge timed out after " + prSeconds + " seconds" }) }))

const prStateOf = (state: string): PrState | null =>
  state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : state === "MERGED" ? "merged" : null

const recordObservation = (
  root: string,
  task: TaskRecord,
  pr: string,
  view: PullRequestView,
  at: string,
  waits: Result.Result<ReadonlyArray<string> | null, BacklogError | RunnerError>,
  prState: PrState
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    yield* routePullRequest(root, task.spec.id, pr, view, at, Result.isSuccess(waits) ? waits.success ?? [] : [])
    const event = prEvent(task, pr, view, at, yield* eventRecorded(root, task.spec.id + ".pr-ready"))
    if (event !== null) {
      yield* recordEvent(root, event)
    }
    yield* writePrState(root, task.spec.id, pr, prState)
  })

const heldAcrossUpdate = (root: string, id: string, pr: string, head: string) =>
  Effect.gen(function*() {
    const pending = yield* readPendingUpdate(root, id).pipe(Effect.mapError((error) => new BacklogError({ detail: error.file + ": " + error.detail })))
    if (pending === null || pending.url !== pr || !(yield* pullRequestHeld(root, id, pending.head))) {
      return false
    }
    return yield* isPendingUpdateHead(pr, pending.head, head)
  })

export const prEvents = (
  root: string,
  task: TaskRecord,
  read: ReadPullRequest,
  at: string,
  yolo: boolean,
  home: string,
  orcMode = false
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
    const view = yield* readPrView(pr, read)
    if (Result.isFailure(view)) {
      return Option.some<BeatAction>({ kind: "pr-unread", task: id, reason: view.failure.detail })
    }
    const prState = prStateOf(view.success.state)
    if (prState === null) {
      return Option.some<BeatAction>({ kind: "pr-unread", task: id, reason: "unknown PR state " + view.success.state })
    }
    if (task.spec.kind !== "ship") {
      yield* writePrState(root, id, pr, prState)
      return Option.none()
    }
    const freshRed = view.success.state === "OPEN" && orcMode && ranClosing(task)?.outcome === "done"
      ? redCheckEvidence(view.success).filter((check) => !(task.ciSentBack ?? []).includes(check.name))
      : []
    if (freshRed.length > 0) {
      const evidence = freshRed.map((check) => check.name + (check.url === undefined ? "" : " " + check.url)).join(", ")
      const sent = yield* sendBack(root, home, { kind: "SendBack", id, words: "Fix the red CI check: " + evidence }, at, "cleared", freshRed.map((check) => check.name)).pipe(Effect.result)
      if (Result.isSuccess(sent)) {
        return Option.none()
      }
    }
    const waits = yield* readWaits(pr, view.success, yolo)
    yield* recordObservation(root, task, pr, view.success, at, waits, prState)
    if (Result.isFailure(waits)) {
      return Option.some<BeatAction>({ kind: "pr-unread", task: id, reason: waits.failure.detail })
    }
    const refusals = checkRefusals(view.success)
    if (view.success.state === "OPEN" && refusals.length > 0) {
      return Option.some<BeatAction>({ kind: "pr-checks", task: id, reason: refusals.join("; ") })
    }
    if (waits.success === null || waits.success.length > 0) {
      return Option.none()
    }
    if (ranClosing(task)?.outcome !== "done" || (yield* pullRequestHeld(root, id, view.success.headRefOid)) || (yield* heldAcrossUpdate(root, id, pr, view.success.headRefOid))) {
      return Option.none()
    }
    return Option.some(yield* mergeTimed(root, id, pr, home))
  })
