import { Effect, Result, Schema } from "effect"
import { prPattern } from "./pr-view"
import type { CommandReply } from "./direct-pr"

const CheckRun = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  head_sha: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String)
})
const CheckRunList = Schema.fromJsonString(Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(CheckRun)
}))
type CheckRun = typeof CheckRun.Type

export type CiVerdict =
  | { readonly kind: "pending"; readonly headSha: string; readonly waiting: ReadonlyArray<string>; readonly reason: string }
  | { readonly kind: "passed"; readonly headSha: string; readonly checks: ReadonlyArray<string> }
  | { readonly kind: "failed"; readonly headSha: string; readonly failing: ReadonlyArray<string> }

type CheckRunsReader = (hostname: string, apiPath: string) => Effect.Effect<CommandReply>

const greenConclusions = new Set(["success", "neutral", "skipped"])

// A re-run gets a new check run under the same name with a higher id, so only the highest id of each name speaks for the check.
const newestByName = (runs: ReadonlyArray<CheckRun>): ReadonlyArray<CheckRun> => {
  const newest = new Map<string, CheckRun>()
  for (const run of runs) {
    const seen = newest.get(run.name)
    if (seen === undefined || run.id > seen.id) {
      newest.set(run.name, run)
    }
  }
  return [...newest.values()]
}

export const ciVerdictOf = (payload: string, headSha: string): Result.Result<CiVerdict, string> => {
  const decoded = Schema.decodeResult(CheckRunList)(payload)
  if (Result.isFailure(decoded)) {
    return Result.fail("the GitHub checks API printed no check-run list orc reads: " + decoded.failure.message)
  }
  const current = newestByName(decoded.success.check_runs.filter((run) => run.head_sha === headSha))
  if (current.length === 0) {
    const stale = decoded.success.check_runs.length
    return Result.succeed({ kind: "pending", headSha, waiting: [], reason: "no check run has reported on " + headSha + " yet" + (stale === 0 ? "" : ", and " + stale.toString() + " check " + (stale === 1 ? "run belongs" : "runs belong") + " to another head") })
  }
  const failing = current.filter((run) => run.status === "completed" && !greenConclusions.has(run.conclusion ?? "")).map((run) => run.name)
  if (failing.length > 0) {
    return Result.succeed({ kind: "failed", headSha, failing })
  }
  const waiting = current.filter((run) => run.status !== "completed").map((run) => run.name)
  if (waiting.length > 0) {
    return Result.succeed({ kind: "pending", headSha, waiting, reason: "the check " + waiting.join(", ") + " has not finished" })
  }
  return Result.succeed({ kind: "passed", headSha, checks: current.map((run) => run.name) })
}

export const ciVerdictLine = (verdict: CiVerdict): string => {
  const head = "CI verdict for " + verdict.headSha.slice(0, 12) + ": "
  switch (verdict.kind) {
    case "passed":
      return head + "passed, " + verdict.checks.join(", ") + " green."
    case "failed":
      return head + "failed, the check " + verdict.failing.join(", ") + " failed."
    case "pending":
      return head + "pending, waiting on CI because " + verdict.reason + "."
  }
}

const checkRunsPath = (prLink: string, headSha: string): { readonly hostname: string; readonly apiPath: string } | null => {
  const matched = prPattern.exec(prLink)
  return matched === null ? null : { hostname: matched[1], apiPath: "repos/" + matched[2] + "/" + matched[3] + "/commits/" + headSha + "/check-runs?per_page=100" }
}

export const readCiVerdict = (read: CheckRunsReader, prLink: string, headSha: string): Effect.Effect<CiVerdict> =>
  Effect.gen(function*() {
    const unread = (reason: string): CiVerdict => ({ kind: "pending", headSha, waiting: [], reason: "orc could not read the check runs: " + reason })
    const target = checkRunsPath(prLink, headSha)
    if (target === null) {
      return unread(prLink + " is no GitHub pull request link")
    }
    const reply = yield* read(target.hostname, target.apiPath)
    if (reply.exitCode !== 0) {
      return unread("gh api exited " + reply.exitCode.toString() + ": " + (reply.stderr.trim() || reply.stdout.trim()))
    }
    const verdict = ciVerdictOf(reply.stdout, headSha)
    return Result.isFailure(verdict) ? unread(verdict.failure) : verdict.success
  })
