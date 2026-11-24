import { DateTime, Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { BeatAction } from "../../entities/attention/index"
import type { BacklogError } from "../../entities/backlog/index"
import { checkRefusals, ownerWordChanges, type PullRequestView, readChangedFiles } from "../../entities/pull-request/index"
import { sendBack } from "../../features/queueing-a-task/index"
import { mergeTask } from "../../features/merging-a-pr/index"
import type { RunnerError } from "../../shared/process/index"

export const beatReady = (yolo: boolean, view: PullRequestView): boolean =>
  yolo && view.state === "OPEN" && checkRefusals(view).length === 0

export const ownerWaits = (
  pr: string,
  view: PullRequestView,
  yolo: boolean
): Effect.Effect<ReadonlyArray<string> | null, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  beatReady(yolo, view) ? readChangedFiles(pr).pipe(Effect.map(ownerWordChanges)) : Effect.succeed(null)

export const yoloMerge = (
  root: string,
  task: string,
  pr: string,
  home: string
): Effect.Effect<BeatAction, never, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  mergeTask(root, task, "yolo-green", (words) => DateTime.now.pipe(Effect.flatMap((now) => sendBack(root, home, { kind: "SendBack", id: task, words }, DateTime.formatIso(now)))), { noWait: true }).pipe(Effect.match({
    onSuccess: (message): BeatAction => message.startsWith("merged ")
      ? { kind: "yolo-merged", task, pr }
      : { kind: "merge-refused", task, reason: message },
    onFailure: (error): BeatAction => ({ kind: "merge-refused", task, reason: error.detail })
  }))
