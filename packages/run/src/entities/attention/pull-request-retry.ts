import { Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, markCiRerun, type TaskRecord } from "../backlog/index"
import { recordEvent } from "../events/index"
import { gh, prPattern, redRuns, type PullRequestView } from "../pull-request/index"
import { itemId } from "./attention"
import { routePullRequest } from "./beat-items"

export const routePullRequestWithRetry = (
  root: string,
  task: TaskRecord,
  pr: string,
  view: PullRequestView,
  at: string,
  waits: ReadonlyArray<string> = []
): Effect.Effect<void, BacklogError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const runs = redRuns(view)
    const repo = pr.match(prPattern)
    if (view.state === "OPEN" && task.state.kind === "closed" && task.spec.kind === "ship" && runs.length > 0 && repo !== null && task.ciReruns?.some((entry) => entry.pr === pr) !== true) {
      const ids = [...new Set(runs.map((run) => run.run))]
      const recorded = yield* markCiRerun(root, task.spec.id, { pr, runs: ids, at }).pipe(
        Effect.catchTag("TaskFileError", (error) => Effect.fail(new BacklogError({ detail: error.file + ": " + error.detail })))
      )
      if (recorded) {
        const failures: Array<string> = []
        for (const id of ids) {
          const said = yield* gh(["run", "rerun", id, "--failed", "-R", repo[1] + "/" + repo[2] + "/" + repo[3]]).pipe(
            Effect.map((result) => result.exitCode === 0 ? null : result.said),
            Effect.catchTag("RunnerError", (error) => Effect.succeed(error.detail))
          )
          if (said !== null) {
            failures.push("gh run rerun " + id + " --failed failed: " + said)
          }
        }
        const reran = task.spec.id + " " + task.spec.title + ": orc reran the failed jobs of " + runs.map((run) => run.name).join(", ") + " on " + pr
        yield* recordEvent(root, { key: itemId(task.spec.id, "ci-rerun", pr), at, text: failures.length === 0 ? reran : reran + ", but " + failures.join("; ") })
        if (failures.length === 0) {
          return
        }
      }
    }
    yield* routePullRequest(root, task.spec.id, pr, view, at, waits)
  })
