import { DateTime, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { DispatchArgs } from "./args"
import { routeReviewQuestions } from "./attention"
import { attentionText } from "./attention-view"
import { listTasks } from "./backlog"
import { BacklogError, backlogPresent, noBacklog } from "./backlog-write"
import { decidedLine, decideReviewQuestions } from "./decider"
import { askDeciderWithPi } from "./decider-ask"
import type { TaskFileError } from "./task-record"

const decideNow = (root: string, home: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (!(yield* backlogPresent(root))) {
      return yield* new BacklogError({ detail: noBacklog(root) })
    }
    const at = DateTime.formatIso(yield* DateTime.now)
    const tasks = yield* listTasks(root)
    yield* routeReviewQuestions(root, tasks, at)
    const decided = yield* decideReviewQuestions(root, tasks, askDeciderWithPi(home), at)
    return decided.length === 0 ? "nothing waits on the decider" : decided.map(decidedLine).join("\n")
  })

export const attentionNow = (
  args: Extract<DispatchArgs, { readonly kind: "ShowAttention" | "DecideAttention" }>,
  root: string,
  home: string
): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  args.kind === "ShowAttention" ? attentionText(args.json, root) : decideNow(root, home)
