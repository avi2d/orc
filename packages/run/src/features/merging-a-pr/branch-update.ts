import { Effect, Schema } from "effect"
import { BacklogError } from "../../entities/backlog/index"
import { CommitSha, gh, prPattern, type PullRequestView } from "../../entities/pull-request/index"

export const refuse = (detail: string): Effect.Effect<never, BacklogError> => Effect.fail(new BacklogError({ detail }))

export const refusal = (id: string, url: string, reasons: ReadonlyArray<string>): string =>
  "orc merge refused " + id + " and merged nothing: " + url + " " + reasons.join("; ")

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

export const compare = (url: string, from: string, to: string, jq: string, firstPageOnly: boolean): ReturnType<typeof gh> => {
  const [, host = "", owner = "", repo = ""] = prPattern.exec(url) ?? []
  const range = encodeURIComponent(from) + "..." + encodeURIComponent(to)
  return gh(["api", "--hostname", host, "repos/" + owner + "/" + repo + "/compare/" + range + (firstPageOnly ? "?per_page=1" : ""), "--jq", jq])
}

const changedPaths = (files: typeof ChangedFiles.Type): ReadonlyArray<string> =>
  files.flatMap(({ filename, previous_filename }) => previous_filename === undefined ? [filename] : [filename, previous_filename])

const compareFileLimit = 300
const selectFiles = "map({filename, previous_filename} | del(.previous_filename | nulls))"

export const branchUpdate = Effect.fnUntraced(function*(landing: { readonly id: string; readonly url: string }, view: PullRequestView) {
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
