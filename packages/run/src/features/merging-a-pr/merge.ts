import { Console, Duration, Effect, Ref, Schema, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, backlogPaths, decisionRefusal, findTask, taskPr, type TaskFileError } from "../../entities/backlog/index"
import { isYolo, readDispatchConfig, readProjects } from "../../shared/config/index"
import type { ConfigError } from "../../shared/config/index"
import type { RunnerError } from "../../shared/process/index"
import type { MergeBasis } from "../../entities/pull-request/index"
import { checkRefusals, CommitSha, gh, greenChecks, prPattern, type PullRequestView, readPullRequest, redChecks } from "../../entities/pull-request/index"
import { watchMainCi } from "./main-ci"

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail }))

const refusal = (id: string, url: string, reasons: ReadonlyArray<string>): string =>
  "orc merge refused " + id + " and merged nothing: " + url + " " + reasons.join("; ")

const readView = (url: string) =>
  readPullRequest(url).pipe(Effect.mapError((error) => new BacklogError({ detail: "orc merge " + error.detail })))

const ChangedFiles = Schema.Array(Schema.Struct({
  filename: Schema.NonEmptyString,
  previous_filename: Schema.optional(Schema.NonEmptyString)
}))
const decodeComparison = Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({
  behind_by: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  base_commit: Schema.Struct({ sha: CommitSha }),
  merge_base_commit: Schema.Struct({ sha: CommitSha }),
  files: ChangedFiles
})))
const decodeChangedFiles = Schema.decodeEffect(Schema.fromJsonString(ChangedFiles))

const compare = (url: string, from: string, to: string, jq: string, firstPageOnly: boolean) => {
  const [, host = "", owner = "", repo = ""] = prPattern.exec(url) ?? []
  const range = encodeURIComponent(from) + "..." + encodeURIComponent(to)
  return gh(["api", "--hostname", host, "repos/" + owner + "/" + repo + "/compare/" + range + (firstPageOnly ? "?per_page=1" : ""), "--jq", jq])
}

const changedPaths = (files: typeof ChangedFiles.Type): ReadonlyArray<string> =>
  files.flatMap(({ filename, previous_filename }) => previous_filename === undefined ? [filename] : [filename, previous_filename])

const compareFileLimit = 300
const selectFiles = "map({filename, previous_filename} | del(.previous_filename | nulls))"

const branchUpdate = Effect.fnUntraced(function*(landing: Landing, view: PullRequestView) {
  const { id, url } = landing
  const unread = (said: string) => refuse(refusal(id, url, ["cannot compare its changed files with " + view.baseRefName + ": " + said]))
  const pr = yield* compare(url, view.baseRefName, view.headRefOid, "{behind_by, base_commit: {sha: .base_commit.sha}, merge_base_commit: {sha: .merge_base_commit.sha}, files: (.files | " + selectFiles + ")}", true)
  if (pr.exitCode !== 0) {
    return yield* unread(pr.said)
  }
  const comparison = yield* decodeComparison(pr.stdout).pipe(Effect.catch((error) => unread(error.message)))
  if (comparison.behind_by === 0) {
    return "current" as const
  }
  const base = yield* compare(url, comparison.merge_base_commit.sha, comparison.base_commit.sha, ".files | " + selectFiles, true)
  if (base.exitCode !== 0) {
    return yield* unread(base.said)
  }
  const baseFiles = yield* decodeChangedFiles(base.stdout).pipe(Effect.catch((error) => unread(error.message)))
  const prPaths = new Set(changedPaths(comparison.files))
  // GitHub caps comparison files at 300, even when paginating commits.
  return comparison.files.length >= compareFileLimit || baseFiles.length >= compareFileLimit || changedPaths(baseFiles).some((path) => prPaths.has(path))
    ? "update" as const
    : "disjoint" as const
})

const behindBy = (id: string, url: string, view: PullRequestView) =>
  Effect.gen(function*() {
    const compared = yield* compare(url, view.baseRefName, view.headRefOid, ".behind_by", false)
    const behind = Number(compared.stdout.trim())
    if (compared.exitCode !== 0 || compared.stdout.trim() === "" || !Number.isInteger(behind)) {
      return yield* refuse(refusal(id, url, ["cannot tell whether it is behind " + view.baseRefName + ": " + compared.said]))
    }
    return behind
  })

type MergeRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
type MergeError = BacklogError | ConfigError | TaskFileError | RunnerError

export type SendBackForFix = (words: string) => Effect.Effect<string, BacklogError | ConfigError | TaskFileError, MergeRequirements>

interface Landing {
  readonly id: string
  readonly url: string
  readonly sendBack: SendBackForFix
}

const checksMinutes = 20
const checksTimeout = Duration.minutes(checksMinutes)
const longestPollSeconds = 15

const commits = (count: number): string => String(count) + " commit" + (count === 1 ? "" : "s")

const refuseAndSendBack = (landing: Landing, reason: string, words: string) =>
  landing.sendBack(words).pipe(
    Effect.catch((error) => Effect.succeed("orc backlog send-back could not send " + landing.id + " back: " + ("file" in error ? error.file + ": " : "") + error.detail)),
    Effect.flatMap((sent) => refuse(refusal(landing.id, landing.url, [reason]) + "; " + sent))
  )

const updateBranch = (landing: Landing, view: PullRequestView) =>
  Effect.gen(function*() {
    const [, host = "", owner = "", repo = ""] = prPattern.exec(landing.url) ?? []
    const number = landing.url.slice(landing.url.lastIndexOf("/") + 1)
    yield* Console.log("Updating from " + view.baseRefName)
    const updated = yield* gh(["api", "--hostname", host, "-X", "PUT", "repos/" + owner + "/" + repo + "/pulls/" + number + "/update-branch", "-f", "expected_head_sha=" + view.headRefOid])
    if (updated.exitCode === 0) {
      return
    }
    const said = updated.stderr + "\n" + updated.stdout
    if (/conflict/i.test(said)) {
      return yield* refuseAndSendBack(
        landing,
        "has a merge conflict with " + view.baseRefName + ", so update-branch could not bring it up to date",
        "orc merge could not update " + landing.url + " from " + view.baseRefName + ": update-branch reported a merge conflict between " + view.headRefOid + " and " + view.baseRefName + ". Merge " + view.baseRefName + " into the branch, settle the conflict and push."
      )
    }
    if (/expected.?head.?sha/i.test(said)) {
      return yield* refuse(refusal(landing.id, landing.url, ["changed after its checks were read: update-branch found its head is no longer " + view.headRefOid + ", so read its checks again before merging"]))
    }
    return yield* refuse(refusal(landing.id, landing.url, ["could not be updated from " + view.baseRefName + ": gh api update-branch said " + updated.said]))
  })

const missingChecks = (checked: PullRequestView, fresh: PullRequestView): ReadonlyArray<string> => {
  const green = new Set(greenChecks(fresh))
  return greenChecks(checked).filter((name) => !green.has(name))
}

const commitParents = (url: string, sha: string) =>
  Effect.gen(function*() {
    const [, host = "", owner = "", repo = ""] = prPattern.exec(url) ?? []
    return yield* gh(["api", "--hostname", host, "repos/" + owner + "/" + repo + "/commits/" + sha, "--jq", ".parents[].sha"])
  })

type Lineage =
  | { readonly sha: string; readonly kind: "child" }
  | { readonly sha: string; readonly kind: "foreign" }
  | { readonly sha: string; readonly kind: "unknown"; readonly said: string }

type PolledHead =
  | { readonly kind: "closed"; readonly view: PullRequestView }
  | { readonly kind: "foreign"; readonly view: PullRequestView }
  | { readonly kind: "red"; readonly view: PullRequestView; readonly red: ReadonlyArray<string> }
  | { readonly kind: "ready"; readonly view: PullRequestView }

const lineageOf = (url: string, checked: string, sha: string): Effect.Effect<Lineage, never, ChildProcessSpawner.ChildProcessSpawner> =>
  commitParents(url, sha).pipe(
    Effect.map((parents): Lineage => {
      if (parents.exitCode !== 0) {
        return { sha, kind: "unknown", said: parents.said }
      }
      const seen = parents.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "")
      return seen.includes(checked) ? { sha, kind: "child" } : { sha, kind: "foreign" }
    }),
    Effect.catch((error) => Effect.succeed({ sha, kind: "unknown" as const, said: error.detail }))
  )

// After update-branch GitHub moves the head a few seconds later and the new head starts with no check, so neither an unmoved head nor an empty rollup is an answer yet.
const awaitNewHead = (
  url: string,
  checked: PullRequestView,
  poll: number,
  unreadable: Ref.Ref<string | null>,
  known?: Lineage
): Effect.Effect<PolledHead, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* Effect.sleep(Duration.seconds(Math.min(2 ** poll, longestPollSeconds)))
    const reading = yield* readView(url).pipe(
      Effect.map((view) => ({ ok: true as const, view })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, said: error.detail }))
    )
    if (!reading.ok) {
      yield* Ref.set(unreadable, reading.said)
      return yield* awaitNewHead(url, checked, poll + 1, unreadable, known)
    }
    yield* Ref.set(unreadable, null)
    const fresh = reading.view
    if (fresh.state !== "OPEN") {
      return { kind: "closed", view: fresh }
    }
    if (fresh.headRefOid === checked.headRefOid) {
      return yield* awaitNewHead(url, checked, poll + 1, unreadable, known)
    }
    let lineage = known
    if (lineage === undefined || lineage.sha !== fresh.headRefOid) {
      lineage = yield* lineageOf(url, checked.headRefOid, fresh.headRefOid)
    }
    if (lineage.kind === "unknown") {
      yield* Ref.set(unreadable, lineage.said)
      return yield* awaitNewHead(url, checked, poll + 1, unreadable, known)
    }
    if (lineage.kind === "foreign") {
      return { kind: "foreign", view: fresh }
    }
    const red = redChecks(fresh)
    if (red.length > 0) {
      return { kind: "red", view: fresh, red }
    }
    if (checkRefusals(fresh).length === 0 && missingChecks(checked, fresh).length === 0) {
      return { kind: "ready", view: fresh }
    }
    return yield* awaitNewHead(url, checked, poll + 1, unreadable, lineage)
  })

class MergeBehind extends Schema.TaggedError<MergeBehind>()("MergeBehind", { detail: Schema.String }) {}

const mergeAt = (landing: Landing, view: PullRequestView) =>
  Effect.gen(function*() {
    const merged = yield* gh(["pr", "merge", landing.url, "--squash", "--match-head-commit", view.headRefOid])
    if (merged.exitCode !== 0) {
      const detail = "gh pr merge refused " + landing.url + ": " + merged.said
      return yield* /\b(?:head )?branch is (?:not up[- ]to[- ]date|out of date)\b/i.test(merged.said)
        ? Effect.fail(new MergeBehind({ detail }))
        : refuse(detail)
    }
    return "merged " + landing.id + " " + landing.url
  })

const landUpdated = (landing: Landing, checked: PullRequestView) =>
  Effect.gen(function*() {
    yield* updateBranch(landing, checked)
    yield* Console.log("Checks running")
    const unreadable = yield* Ref.make<string | null>(null)
    const settled = yield* awaitNewHead(landing.url, checked, 0, unreadable).pipe(
      Effect.timeoutOrElse({
        duration: checksTimeout,
        orElse: () =>
          Effect.gen(function*() {
            const said = yield* Ref.get(unreadable)
            return yield* refuse(said === null
              ? refusal(landing.id, landing.url, ["was updated from " + checked.baseRefName + ", and the checks on its new head did not all report within " + checksMinutes + " minutes, so run orc merge again once they do"])
              : refusal(landing.id, landing.url, ["could not read its new head after the update from " + checked.baseRefName + ": " + said + ", so run orc merge again once it reads"]))
          })
      })
    )
    if (settled.kind === "closed") {
      return yield* refuse(refusal(landing.id, landing.url, ["is " + settled.view.state.toLowerCase() + ", not open"]))
    }
    if (settled.kind === "foreign") {
      return yield* refuse(refusal(landing.id, landing.url, ["changed after its checks were read: update-branch found its head is no longer " + checked.headRefOid + ", so read its checks again before merging"]))
    }
    if (settled.kind === "red") {
      const view = settled.view
      return yield* refuseAndSendBack(
        landing,
        "the check " + settled.red.join(", ") + " is red on its new head " + view.headRefOid + " after the update from " + view.baseRefName,
        "orc merge updated " + landing.url + " from " + view.baseRefName + ", and the check " + settled.red.join(", ") + " is red on the new head " + view.headRefOid + ". Fix the failure and push."
      )
    }
    const view = settled.view
    const behind = yield* behindBy(landing.id, landing.url, view)
    if (behind > 0) {
      return yield* refuse(refusal(landing.id, landing.url, ["is still " + commits(behind) + " behind " + view.baseRefName + " after the update, because " + view.baseRefName + " moved again, so run orc merge again"]))
    }
    return yield* mergeAt(landing, view).pipe(Effect.catchTag("MergeBehind", (error) => refuse(error.detail)))
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
  basis: MergeBasis,
  sendBack: SendBackForFix
): Effect.Effect<string, MergeError, MergeRequirements> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, id)
    const decision = decisionRefusal(record, "merge")
    if (decision !== null) {
      return yield* refuse(decision)
    }
    const url = taskPr(record)
    if (url === null) {
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
    const landing: Landing = { id, url, sendBack }
    const reasons = checkRefusals(view)
    if (reasons.length > 0) {
      return yield* refuse(refusal(id, url, reasons))
    }
    const update = yield* branchUpdate(landing, view)
    if (update === "update") {
      return yield* landUpdated(landing, view)
    }
    return yield* mergeAt(landing, view).pipe(
      Effect.flatMap((merged) => update === "disjoint"
        ? watchMainCi(root, { task: id, url, branch: view.baseRefName, checkedHead: view.headRefOid }).pipe(
          Effect.catchTag("BacklogError", (error) => refuse(merged + ", but Orc could not watch main CI: " + error.detail)),
          Effect.as(merged)
        )
        : Effect.succeed(merged)),
      Effect.catchTag("MergeBehind", (error) => update === "disjoint" ? landUpdated(landing, view) : refuse(error.detail))
    )
  })
