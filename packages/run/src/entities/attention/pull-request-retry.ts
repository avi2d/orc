import { Duration, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, markCiRerun, type TaskRecord } from "../backlog/index"
import { recordEvent } from "../events/index"
import { gh, pendingRedRuns, prPattern, redRuns, type PullRequestView } from "../pull-request/index"
import { itemId } from "./attention"
import { routePullRequest } from "./beat-items"

const rerunFailed = (
  root: string,
  task: TaskRecord,
  pr: string,
  repo: string,
  runs: ReturnType<typeof redRuns>,
  at: string
): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const ids = [...new Set(runs.map((run) => run.run))]
    const failures: Array<string> = []
    for (const id of ids) {
      const said = yield* gh(["run", "rerun", id, "--failed", "-R", repo]).pipe(
        Effect.map((result) => result.exitCode === 0 ? null : result.said),
        Effect.catchTag("RunnerError", (error) => Effect.succeed(error.detail)),
        Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.succeed("the rerun timed out after 30 seconds") })
      )
      if (said !== null) {
        failures.push("gh run rerun " + id + " --failed failed: " + said)
      }
    }
    const reran = task.spec.id + " " + task.spec.title + ": orc reran the failed jobs of " + runs.map((run) => run.name).join(", ") + " on " + pr
    yield* recordEvent(root, { key: itemId(task.spec.id, "ci-rerun", pr), at, text: failures.length === 0 ? reran : reran + ", but " + failures.join("; ") })
    return failures.length === 0
  })

export const routePullRequestWithRetry = (
  root: string,
  task: TaskRecord,
  pr: string,
  view: PullRequestView,
  at: string,
  waits: ReadonlyArray<string> = []
): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const runs = redRuns(view)
    const repo = pr.match(prPattern)
    const shipPr = view.state === "OPEN" && task.state.kind === "closed" && task.spec.kind === "ship"
    const rerunRecorded = task.ciReruns?.some((entry) => entry.pr === pr) === true
    if (shipPr && !rerunRecorded && pendingRedRuns(view)) {
      yield* routePullRequest(root, task.spec.id, pr, view, at, waits, true)
      return true
    }
    if (shipPr && runs.length > 0 && repo !== null && !rerunRecorded) {
      const ids = [...new Set(runs.map((run) => run.run))]
      const recorded = yield* markCiRerun(root, task.spec.id, { pr, runs: ids, at }).pipe(
        Effect.catch((error) => recordEvent(root, {
          key: itemId(task.spec.id, "ci-rerun-record-failed", pr),
          at,
          text: task.spec.id + ": could not record the CI rerun for " + pr + ": " + error.detail
        }).pipe(Effect.as(false)))
      )
      if (recorded && (yield* rerunFailed(root, task, pr, repo[1] + "/" + repo[2] + "/" + repo[3], runs, at))) {
        yield* routePullRequest(root, task.spec.id, pr, view, at, waits, true)
        return true
      }
    }
    yield* routePullRequest(root, task.spec.id, pr, view, at, waits)
    return false
  })
