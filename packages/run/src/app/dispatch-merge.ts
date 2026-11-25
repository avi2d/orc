import { DateTime, Effect, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { DispatchArgs } from "./dispatch-args"
import { backlogRoot, type BacklogError, type TaskFileError } from "../entities/backlog/index"
import type { ConfigError } from "../shared/config/index"
import type { RunnerError } from "../shared/process/index"
import { sendBack } from "../features/queueing-a-task/index"
import { mergeTask } from "../features/merging-a-pr/index"

export const mergeNow = (args: Extract<DispatchArgs, { readonly kind: "MergeTask" }>, home: string): Effect.Effect<string, BacklogError | ConfigError | TaskFileError | RunnerError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  mergeTask(
    backlogRoot(home),
    args.id,
    args.basis,
    (words) => DateTime.now.pipe(Effect.flatMap((now) => sendBack(backlogRoot(home), home, { kind: "SendBack", id: args.id, words }, DateTime.formatIso(now)))),
    { noWait: args.noWait }
  ).pipe(Effect.map((outcome) => outcome.message))
