import { Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, markCiRerun, type TaskRecord } from "../backlog/index"
import { checkRefusals, gh, greenChecks, prPattern, type PullRequestView, redChecks, type RedRun, redRuns } from "../pull-request/index"
import { recordEvent } from "../events/index"
import type { AttentionItem, Asked } from "./attention-item"
import { closeItem, itemId, openItem, openItems, readItem, withdrawItem, writeItem } from "./attention"

const openOrReopenPrItem = (root: string, id: string, asked: Asked): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const item = yield* readItem(root, id)
    if (item === null) {
      yield* Effect.asVoid(openItem(root, id, asked))
    } else if (item.state.kind === "withdrawn") {
      yield* writeItem(root, id, { ...asked, state: { kind: "open" } })
    } else if (item.state.kind === "open" && item.text !== asked.text) {
      yield* writeItem(root, id, { ...asked, asked: item.asked, state: { kind: "open" } })
    }
  })

// The rerun is recorded before gh runs, so a beat that dies between the two never reruns the same PR twice.
const rerunFailedJobs = (root: string, task: TaskRecord, pr: string, runs: ReadonlyArray<RedRun>, at: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const repo = pr.match(prPattern)
    if (task.state.kind !== "closed" || task.state.ciRerun?.pr === pr || runs.length === 0 || repo === null) {
      return false
    }
    const ids = [...new Set(runs.map((run) => run.run))]
    const recorded = yield* markCiRerun(root, task.spec.id, { pr, runs: ids, at }).pipe(
      Effect.catchTag("TaskFileError", (error) => Effect.fail(new BacklogError({ detail: error.file + ": " + error.detail })))
    )
    if (!recorded) {
      return false
    }
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
    return failures.length === 0
  })

// Each head commit gets its own items, so a fix pushed after a red check opens anew.
export const routePullRequest = (root: string, record: TaskRecord, pr: string, view: PullRequestView, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const task = record.spec.id
    const ended = view.state === "MERGED" ? "merged" : view.state === "CLOSED" ? "closed without merging" : null
    const refusals = checkRefusals(view)
    const red = redChecks(view)
    const holds = (kind: AttentionItem["kind"]): boolean => ended === null && (kind === "check-red" ? refusals.length > 0 : red.length === 0)
    const prefixes = [itemId(task, "check-red") + ".", itemId(task, "pr-ready") + "."]
    const settled = (yield* openItems(root, (name) => prefixes.some((prefix) => name.startsWith(prefix)))).filter((entry) =>
      !(entry.id === itemId(task, entry.item.kind, view.headRefOid) && holds(entry.item.kind))
    )
    yield* Effect.forEach(settled, (entry) =>
      entry.item.kind === "pr-ready" && ended !== null
        ? Effect.asVoid(closeItem(root, entry.id, { words: ended, at }))
        : Effect.asVoid(withdrawItem(root, entry.id, ended === null ? "head or checks changed" : "PR " + ended, at)), { discard: true })
    if (ended !== null) {
      return
    }
    if (red.length > 0) {
      const runs = redRuns(view)
      if (yield* rerunFailedJobs(root, record, pr, runs, at)) {
        return
      }
      const links = runs.length === 0 ? "" : " at " + runs.map((run) => run.detailsUrl).join(", ")
      yield* openOrReopenPrItem(root, itemId(task, "check-red", view.headRefOid), { kind: "check-red", task, text: pr + ": the check " + red.join(", ") + " is red" + links, asked: at, owner: "user" })
    } else if (refusals.length === 0) {
      yield* openOrReopenPrItem(root, itemId(task, "pr-ready", view.headRefOid), { kind: "pr-ready", task, text: pr + " is ready to merge, checks green: " + greenChecks(view).join(", "), asked: at, owner: "user" })
    }
  })
