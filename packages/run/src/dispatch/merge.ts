import { Effect, type FileSystem, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, backlogPaths, findTask } from "./backlog"
import { isYolo, readDispatchConfig, readProjects } from "./config"
import type { ConfigError } from "../json-file"
import { capture, type RunnerError } from "./runner"
import type { TaskFileError } from "./task-record"
import type { MergeBasis } from "./merge-basis"

const CheckRun = Schema.Struct({
  workflowName: Schema.optional(Schema.String),
  detailsUrl: Schema.optional(Schema.String),
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
  startedAt: Schema.String
})
const StatusContext = Schema.Struct({
  context: Schema.String,
  state: Schema.String
})
const PullRequestView = Schema.fromJsonString(Schema.Struct({
  state: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  statusCheckRollup: Schema.Array(Schema.Union([CheckRun, StatusContext]))
}))
type PullRequestView = typeof PullRequestView.Type
type CheckRun = typeof CheckRun.Type

type CheckVerdict = "green" | "red" | "unreported"
type NamedVerdict = { readonly name: string; readonly verdict: CheckVerdict }

const greenConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
const unreportedStates = new Set(["PENDING", "EXPECTED"])

const runVerdict = (run: CheckRun): CheckVerdict => {
  if (run.status !== "COMPLETED") {
    return "unreported"
  }
  return greenConclusions.has(run.conclusion) ? "green" : "red"
}

// GitHub keeps a cancelled run beside its re-run under one run and name, so only the newest run of each run and name speaks for the check.
const runScope = (run: CheckRun): string => run.detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1] ?? run.workflowName ?? ""
const newestRuns = (runs: ReadonlyArray<CheckRun>): ReadonlyArray<CheckRun> => {
  const newest = new Map<string, CheckRun>()
  for (const run of runs) {
    const key = runScope(run) + "\0" + run.name
    const seen = newest.get(key)
    if (seen === undefined || run.startedAt > seen.startedAt) {
      newest.set(key, run)
    }
  }
  return [...newest.values()]
}

const checkVerdicts = (view: PullRequestView): ReadonlyArray<NamedVerdict> => {
  const runs = view.statusCheckRollup.filter((entry) => "status" in entry)
  const contexts = view.statusCheckRollup.filter((entry) => "context" in entry)
  return [
    ...newestRuns(runs).map((run) => ({ name: run.workflowName === undefined || run.workflowName === "" ? run.name : run.workflowName + "/" + run.name, verdict: runVerdict(run) })),
    ...contexts.map((context): NamedVerdict => ({
      name: context.context,
      verdict: context.state === "SUCCESS" ? "green" : unreportedStates.has(context.state) ? "unreported" : "red"
    }))
  ]
}

const namesWith = (verdicts: ReadonlyArray<NamedVerdict>, verdict: CheckVerdict): ReadonlyArray<string> =>
  verdicts.filter((entry) => entry.verdict === verdict).map((entry) => entry.name || "(unnamed check)")

const checkRefusals = (view: PullRequestView): ReadonlyArray<string> => {
  const verdicts = checkVerdicts(view)
  if (verdicts.length === 0) {
    return ["no check has reported on it, so it cannot read green"]
  }
  const red = namesWith(verdicts, "red")
  const unreported = namesWith(verdicts, "unreported")
  return [
    ...(red.length === 0 ? [] : ["the check " + red.join(", ") + " is red"]),
    ...(unreported.length === 0 ? [] : ["the check " + unreported.join(", ") + " has not reported"])
  ]
}

const prPattern = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+$/

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail }))

const refusal = (id: string, url: string, reasons: ReadonlyArray<string>): string =>
  "orc merge refused " + id + " and merged nothing: " + url + " " + reasons.join("; ")

const gh = (args: ReadonlyArray<string>) =>
  capture(["gh", ...args], null).pipe(
    Effect.map((result) => ({ ...result, said: (result.stderr.trim() || result.stdout.trim() || "exit " + String(result.exitCode)) }))
  )

const readView = (url: string) =>
  Effect.gen(function*() {
    const viewed = yield* gh(["pr", "view", url, "--json", "state,headRefOid,baseRefName,statusCheckRollup"])
    if (viewed.exitCode !== 0) {
      return yield* refuse("orc merge cannot read " + url + ": " + viewed.said)
    }
    return yield* Schema.decodeEffect(PullRequestView)(viewed.stdout).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "orc merge cannot read " + url + ": gh printed no pull request orc reads: " + error.message }))
    )
  })

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
): Effect.Effect<string, BacklogError | ConfigError | TaskFileError | RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
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
