import { DateTime, Effect } from "effect"
import type { DispatchArgs } from "./dispatch-args"
import { backlogRoot } from "../entities/backlog/index"
import { sendBack } from "../features/queueing-a-task/index"
import { mergeTask } from "../features/merging-a-pr/index"

export const mergeNow = (args: Extract<DispatchArgs, { readonly kind: "MergeTask" }>, home: string): ReturnType<typeof mergeTask> =>
  mergeTask(
    backlogRoot(home),
    args.id,
    args.basis,
    (words) => DateTime.now.pipe(Effect.flatMap((now) => sendBack(backlogRoot(home), home, { kind: "SendBack", id: args.id, words }, DateTime.formatIso(now)))),
    { noWait: args.noWait }
  )
