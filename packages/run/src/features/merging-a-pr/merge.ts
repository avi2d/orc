import { Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, backlogPaths, findTask, type TaskFileError } from "../../entities/backlog/index"
import { isYolo, readDispatchConfig, readProjects } from "../../shared/config/index"
import type { ConfigError } from "../../shared/config/index"
import type { RunnerError } from "../../shared/process/index"
import type { MergeBasis } from "../../entities/pull-request/index"
import { checkRefusals, gh, prPattern, type PullRequestView, readPullRequest } from "../../entities/pull-request/index"

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail }))

const refusal = (id: string, url: string, reasons: ReadonlyArray<string>): string =>
  "orc merge refused " + id + " and merged nothing: " + url + " " + reasons.join("; ")

const readView = (url: string) =>
  readPullRequest(url).pipe(Effect.mapError((error) => new BacklogError({ detail: "orc merge " + error.detail })))

const behindBy = (id: string, url: string, view: PullRequestView) =>
  Effect.gen(function*() {
    const [, host = "", owner = "", repo = ""] = prPattern.exec(url) ?? []
    const compared = yield* gh(["api", "--hostname", host, "repos/" + owner + "/" + repo + "/compare/" + encodeURIComponent(view.baseRefName) + "..." + view.headRefOid, "--jq", ".behind_by"])
    const behind = Number(compared.stdout.trim())
    if (compared.exitCode !== 0 || compared.stdout.trim() === "" || !Number.isInteger(behind)) {
      return yield* refuse(refusal(id, url, ["cannot tell whether it is behind " + view.baseRefName + ": " + compared.said]))
    }
    return behind
  })

const yoloRefusal = (place: { readonly root: string }, project: string) =>
  Effect.gen(function*() {
    const paths = backlogPaths(place.root)
    const config = yield* readDispatchConfig(paths.dispatchConfig)
    const found = (yield* readProjects(paths.projects, config.machines)).find((candidate) => candidate.name === project)
    if (found === undefined) {
      return "the project " + project + " is not in " + paths.projects + ", so it has no yolo true"
    }
    return isYolo(found) ? null : "the project " + project + " has no yolo true, so its PRs merge only on the captain's word"
  })

export const mergeTask = (
  root: string,
  id: string,
  basis: MergeBasis
): Effect.Effect<string, BacklogError | ConfigError | TaskFileError | RunnerError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const closing = record.state.kind === "closed" && record.state.closing.outcome !== "start-failed" ? record.state.closing : null
    const url = closing?.pr ?? null
    if (closing === null || url === null) {
      return yield* refuse(id + " names no PR to merge")
    }
    if (!prPattern.test(url)) {
      return yield* refuse(id + " names the PR " + url + ", which is no GitHub pull request link")
    }
    if (basis === "yolo-green") {
      const refused = yield* yoloRefusal({ root }, record.spec.project)
      if (refused !== null) {
        return yield* refuse("orc merge refused " + id + " on yolo-green and merged nothing: " + refused)
      }
    }
    const view = yield* readView(url)
    if (view.state !== "OPEN") {
      return yield* refuse(refusal(id, url, ["is " + view.state.toLowerCase() + ", not open"]))
    }
    const reasons = [...checkRefusals(view)]
    const behind = yield* behindBy(id, url, view)
    if (behind > 0) {
      reasons.push("is " + String(behind) + " commit" + (behind === 1 ? "" : "s") + " behind " + view.baseRefName + ", so update the branch and let its checks run again")
    }
    if (reasons.length > 0) {
      return yield* refuse(refusal(id, url, reasons))
    }
    const merged = yield* gh(["pr", "merge", url, "--squash", "--match-head-commit", view.headRefOid])
    if (merged.exitCode !== 0) {
      return yield* refuse("gh pr merge refused " + url + ": " + merged.said)
    }
    return "merged " + id + " " + url
  })
