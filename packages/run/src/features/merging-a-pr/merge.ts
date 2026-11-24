import { Console, Duration, Effect, Ref, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, backlogPaths, decisionRefusal, findTask, taskPr, type TaskFileError } from "../../entities/backlog/index"
import { isYolo, readDispatchConfig, readProjects } from "../../shared/config/index"
import type { ConfigError } from "../../shared/config/index"
import type { RunnerError } from "../../shared/process/index"
import type { MergeBasis } from "../../entities/pull-request/index"
import { checkRefusals, gh, greenChecks, prPattern, type PullRequestView, readPullRequest, redChecks } from "../../entities/pull-request/index"
import { clearPendingUpdate, readPendingUpdate, savePendingUpdate, type PendingUpdate } from "./pending-update"

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

type MergeRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
type MergeError = BacklogError | ConfigError | TaskFileError | RunnerError

export type SendBackForFix = (words: string) => Effect.Effect<string, BacklogError | ConfigError | TaskFileError, MergeRequirements>

interface Landing {
  readonly root: string
  readonly id: string
  readonly url: string
  readonly basis: MergeBasis
  readonly sendBack: SendBackForFix
}

interface Approved {
  readonly head: string
  readonly green: ReadonlyArray<string>
}

const approvedAt = (view: PullRequestView): Approved => ({ head: view.headRefOid, green: greenChecks(view) })

const checksMinutes = 20
const checksTimeout = Duration.minutes(checksMinutes)
const longestPollSeconds = 15

const commits = (count: number): string => String(count) + " commit" + (count === 1 ? "" : "s")

const refuseAndSendBack = (landing: Landing, reason: string, words: string) =>
  clearPendingUpdate(landing.root, landing.id).pipe(
    Effect.flatMap(() => landing.sendBack(words)),
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

const missingChecks = (approved: Approved, fresh: PullRequestView): ReadonlyArray<string> => {
  const green = new Set(greenChecks(fresh))
  return approved.green.filter((name) => !green.has(name))
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

type Judgement =
  | PolledHead
  | { readonly kind: "waiting"; readonly lineage: Lineage | undefined }
  | { readonly kind: "unreadable"; readonly said: string }

const judgeHead = (
  url: string,
  approved: Approved,
  fresh: PullRequestView,
  known: Lineage | undefined
): Effect.Effect<Judgement, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (fresh.state !== "OPEN") {
      return { kind: "closed", view: fresh }
    }
    if (fresh.headRefOid === approved.head) {
      return { kind: "waiting", lineage: known }
    }
    const lineage = known !== undefined && known.sha === fresh.headRefOid ? known : yield* lineageOf(url, approved.head, fresh.headRefOid)
    if (lineage.kind === "unknown") {
      return { kind: "unreadable", said: lineage.said }
    }
    if (lineage.kind === "foreign") {
      return { kind: "foreign", view: fresh }
    }
    const red = redChecks(fresh)
    if (red.length > 0) {
      return { kind: "red", view: fresh, red }
    }
    if (checkRefusals(fresh).length === 0 && missingChecks(approved, fresh).length === 0) {
      return { kind: "ready", view: fresh }
    }
    return { kind: "waiting", lineage }
  })

// After update-branch GitHub moves the head a few seconds later and the new head starts with no check, so neither an unmoved head nor an empty rollup is an answer yet.
const awaitNewHead = (
  url: string,
  approved: Approved,
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
      return yield* awaitNewHead(url, approved, poll + 1, unreadable, known)
    }
    yield* Ref.set(unreadable, null)
    const judged = yield* judgeHead(url, approved, reading.view, known)
    if (judged.kind === "unreadable") {
      yield* Ref.set(unreadable, judged.said)
      return yield* awaitNewHead(url, approved, poll + 1, unreadable, known)
    }
    if (judged.kind === "waiting") {
      return yield* awaitNewHead(url, approved, poll + 1, unreadable, judged.lineage)
    }
    return judged
  })

const mergeAt = (landing: Landing, view: PullRequestView) =>
  Effect.gen(function*() {
    const merged = yield* gh(["pr", "merge", landing.url, "--squash", "--match-head-commit", view.headRefOid])
    if (merged.exitCode !== 0) {
      return yield* refuse("gh pr merge refused " + landing.url + ": " + merged.said)
    }
    yield* clearPendingUpdate(landing.root, landing.id)
    return "merged " + landing.id + " " + landing.url
  })

type Unsettled = Exclude<PolledHead, { readonly kind: "ready" }>

const refuseUnsettled = (landing: Landing, approved: Approved, settled: Unsettled) =>
  Effect.gen(function*() {
    if (settled.kind === "closed") {
      return yield* refuse(refusal(landing.id, landing.url, ["is " + settled.view.state.toLowerCase() + ", not open"]))
    }
    if (settled.kind === "foreign") {
      return yield* refuse(refusal(landing.id, landing.url, ["changed after its checks were read: update-branch found its head is no longer " + approved.head + ", so read its checks again before merging"]))
    }
    const view = settled.view
    return yield* refuseAndSendBack(
      landing,
      "the check " + settled.red.join(", ") + " is red on its new head " + view.headRefOid + " after the update from " + view.baseRefName,
      "orc merge updated " + landing.url + " from " + view.baseRefName + ", and the check " + settled.red.join(", ") + " is red on the new head " + view.headRefOid + ". Fix the failure and push."
    )
  })

const waitCommand = (landing: Landing): string => "orc merge " + landing.id + " --basis " + landing.basis

const retryCommand = (landing: Landing): string => waitCommand(landing) + " --no-wait"

const retryAdvice = (landing: Landing): string =>
  "run " + retryCommand(landing) + " again once the new head's checks have reported, or run " + waitCommand(landing) + " to wait for the new head's own checks instead of the ones saved before the update"

const awaitUpdatedAndMerge = (landing: Landing, checked: PullRequestView, approved: Approved) =>
  Effect.gen(function*() {
    yield* Console.log("Checks running")
    const unreadable = yield* Ref.make<string | null>(null)
    const settled = yield* awaitNewHead(landing.url, approved, 0, unreadable).pipe(
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
    if (settled.kind !== "ready") {
      return yield* refuseUnsettled(landing, approved, settled)
    }
    const view = settled.view
    const behind = yield* behindBy(landing.id, landing.url, view)
    if (behind > 0) {
      return yield* refuse(refusal(landing.id, landing.url, ["is still " + commits(behind) + " behind " + view.baseRefName + " after the update, because " + view.baseRefName + " moved again, so run orc merge again"]))
    }
    return yield* mergeAt(landing, view)
  })

const landUpdated = (landing: Landing, checked: PullRequestView, approved: Approved, noWait: boolean) =>
  Effect.gen(function*() {
    if (noWait) {
      yield* savePendingUpdate(landing.root, landing.id, { url: landing.url, ...approved })
    }
    yield* updateBranch(landing, checked)
    if (noWait) {
      return "requested branch update for " + landing.id + " " + landing.url + "; not merged. Run " + retryCommand(landing) + " again once the new head checks are green."
    }
    return yield* awaitUpdatedAndMerge(landing, checked, approved)
  })

const checkUpdatedHead = (landing: Landing, pending: PendingUpdate, view: PullRequestView) =>
  Effect.gen(function*() {
    const judged = yield* judgeHead(landing.url, pending, view, undefined)
    if (judged.kind === "ready") {
      return
    }
    if (judged.kind === "unreadable") {
      return yield* refuse(refusal(landing.id, landing.url, ["cannot tell whether its new head " + view.headRefOid + " comes from the update of " + pending.head + ": " + judged.said + ", so run " + retryCommand(landing) + " again once it reads"]))
    }
    if (judged.kind === "waiting") {
      const missing = missingChecks(pending, view)
      return yield* refuse(refusal(landing.id, landing.url, [
        ...checkRefusals(view),
        ...(missing.length === 0 ? [] : ["the check " + missing.join(", ") + " was green before the update and has not reported green on its new head " + view.headRefOid]),
        retryAdvice(landing)
      ]))
    }
    yield* clearPendingUpdate(landing.root, landing.id)
    return yield* refuseUnsettled(landing, pending, judged)
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

const openPullRequest = (root: string, id: string, basis: MergeBasis) =>
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
    return { url, view }
  })

const mergeChecked = (landing: Landing, view: PullRequestView, pending: PendingUpdate | null, noWait: boolean) =>
  Effect.gen(function*() {
    const { id, url } = landing
    const reasons = checkRefusals(view)
    if (reasons.length > 0) {
      return yield* refuse(refusal(id, url, reasons))
    }
    const behind = yield* behindBy(id, url, view)
    const checked = approvedAt(view)
    const sameHead = pending?.head === checked.head ? pending : null
    if (behind > 0) {
      const approved = sameHead === null ? checked : { ...checked, green: [...new Set([...sameHead.green, ...checked.green])] }
      return yield* landUpdated(landing, view, approved, noWait)
    }
    if (sameHead !== null) {
      return yield* refuse(refusal(id, url, ["its branch update has not produced a new head, so " + retryAdvice(landing)]))
    }
    return yield* mergeAt(landing, view)
  })

export const mergeTask = (
  root: string,
  id: string,
  basis: MergeBasis,
  sendBack: SendBackForFix,
  options: { readonly noWait: boolean } = { noWait: false }
): Effect.Effect<string, MergeError, MergeRequirements> =>
  Effect.gen(function*() {
    const { url, view } = yield* openPullRequest(root, id, basis)
    const landing: Landing = { root, id, url, basis, sendBack }
    const saved = yield* readPendingUpdate(root, id)
    const savedHere = saved?.url === url ? saved : null
    if (!options.noWait && savedHere !== null) {
      yield* clearPendingUpdate(root, id)
      if (savedHere.head !== view.headRefOid) {
        return yield* awaitUpdatedAndMerge(landing, view, { head: savedHere.head, green: [] })
      }
    }
    const pending = options.noWait ? savedHere : null
    if (pending !== null && pending.head !== view.headRefOid) {
      yield* checkUpdatedHead(landing, pending, view)
    }
    return yield* mergeChecked(landing, view, pending, options.noWait)
  })
