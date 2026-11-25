import { Effect, Result, Schema } from "effect"
import { prPattern } from "./pr-view"
import type { CommandReply } from "./direct-pr"

export const ciWaitingQuestionId = "ci-waiting"

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

const perPage = 100

const decodeCheckRuns = (payload: string): Result.Result<{ readonly total: number; readonly runs: ReadonlyArray<CheckRun> }, string> => {
  const decoded = Schema.decodeResult(CheckRunList)(payload)
  return Result.isFailure(decoded)
    ? Result.fail("the GitHub checks API printed no check-run list orc reads: " + decoded.failure.message)
    : Result.succeed({ total: decoded.success.total_count, runs: decoded.success.check_runs })
}

const verdictOfRuns = (runs: ReadonlyArray<CheckRun>, headSha: string): CiVerdict => {
  const current = runs.filter((run) => run.head_sha === headSha)
  if (current.length === 0) {
    const stale = runs.length
    return { kind: "pending", headSha, waiting: [], reason: "no check run has reported on " + headSha + " yet" + (stale === 0 ? "" : ", and " + stale.toString() + " check " + (stale === 1 ? "run belongs" : "runs belong") + " to another head") }
  }
  const failing = current.filter((run) => run.status === "completed" && !greenConclusions.has(run.conclusion ?? "")).map((run) => run.name)
  if (failing.length > 0) {
    return { kind: "failed", headSha, failing }
  }
  const waiting = current.filter((run) => run.status !== "completed").map((run) => run.name)
  if (waiting.length > 0) {
    return { kind: "pending", headSha, waiting, reason: "the check " + waiting.join(", ") + " has not finished" }
  }
  return { kind: "passed", headSha, checks: current.map((run) => run.name) }
}

export const ciVerdictOf = (payload: string, headSha: string): Result.Result<CiVerdict, string> => {
  const decoded = decodeCheckRuns(payload)
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  if (decoded.success.runs.length < decoded.success.total) {
    return Result.succeed({ kind: "pending", headSha, waiting: [], reason: "orc read " + decoded.success.runs.length.toString() + " of " + decoded.success.total.toString() + " check runs for " + headSha })
  }
  return Result.succeed(verdictOfRuns(decoded.success.runs, headSha))
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
  return matched === null ? null : { hostname: matched[1], apiPath: "repos/" + matched[2] + "/" + matched[3] + "/commits/" + headSha + "/check-runs?per_page=" + perPage.toString() }
}

export const readCiVerdict = (read: CheckRunsReader, prLink: string, headSha: string): Effect.Effect<CiVerdict> =>
  Effect.gen(function*() {
    const unread = (reason: string): CiVerdict => ({ kind: "pending", headSha, waiting: [], reason: "orc could not read the check runs: " + reason })
    const target = checkRunsPath(prLink, headSha)
    if (target === null) {
      return unread(prLink + " is no GitHub pull request link")
    }
    const first = yield* read(target.hostname, target.apiPath)
    if (first.exitCode !== 0) {
      return unread("gh api exited " + first.exitCode.toString() + ": " + (first.stderr.trim() || first.stdout.trim()))
    }
    const decoded = decodeCheckRuns(first.stdout)
    if (Result.isFailure(decoded)) {
      return unread(decoded.failure)
    }
    const runs = [...decoded.success.runs]
    let total = decoded.success.total
    let page = 2
    while (runs.length < total) {
      const reply = yield* read(target.hostname, target.apiPath + "&page=" + page.toString())
      if (reply.exitCode !== 0) {
        return unread("gh api exited " + reply.exitCode.toString() + ": " + (reply.stderr.trim() || reply.stdout.trim()))
      }
      const next = decodeCheckRuns(reply.stdout)
      if (Result.isFailure(next)) {
        return unread(next.failure)
      }
      total = next.success.total
      if (next.success.runs.length === 0) {
        break
      }
      runs.push(...next.success.runs)
      page += 1
    }
    if (runs.length < total) {
      return { kind: "pending", headSha, waiting: [], reason: "orc read " + runs.length.toString() + " of " + total.toString() + " check runs for " + headSha }
    }
    return verdictOfRuns(runs, headSha)
  })
