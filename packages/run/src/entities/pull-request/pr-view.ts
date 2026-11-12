import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError } from "../backlog/index"
import { capture, type Captured } from "../../shared/process/index"
import type { RunnerError } from "../../shared/process/index"

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
export type PullRequestView = typeof PullRequestView.Type
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

export const greenChecks = (view: PullRequestView): ReadonlyArray<string> => namesWith(checkVerdicts(view), "green")

export const redChecks = (view: PullRequestView): ReadonlyArray<string> => namesWith(checkVerdicts(view), "red")

export const checkRefusals = (view: PullRequestView): ReadonlyArray<string> => {
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

export const prPattern = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+$/

type Said = Captured & { readonly said: string }

export const gh = (args: ReadonlyArray<string>): Effect.Effect<Said, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(["gh", ...args], null).pipe(
    Effect.map((result) => ({ ...result, said: (result.stderr.trim() || result.stdout.trim() || "exit " + String(result.exitCode)) }))
  )

export const readPullRequest = (url: string): Effect.Effect<PullRequestView, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const viewed = yield* gh(["pr", "view", url, "--json", "state,headRefOid,baseRefName,statusCheckRollup"])
    if (viewed.exitCode !== 0) {
      return yield* new BacklogError({ detail: "cannot read " + url + ": " + viewed.said })
    }
    return yield* Schema.decodeEffect(PullRequestView)(viewed.stdout).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read " + url + ": gh printed no pull request orc reads: " + error.message }))
    )
  })
