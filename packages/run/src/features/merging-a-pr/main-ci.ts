import { Duration, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, platformFailure, publishOnce, readIfPresent, readNames, TaskId } from "../../entities/backlog/index"
import { recordEvent } from "../../entities/events/index"
import { CommitSha, gh, prPattern } from "../../entities/pull-request/index"

const Watch = Schema.fromJsonString(Schema.Struct({
  task: TaskId,
  url: Schema.String.check(Schema.isPattern(prPattern)),
  branch: Schema.NonEmptyString,
  checkedHead: CommitSha
}))
type Watch = typeof Watch.Type

const MergedCommit = Schema.fromJsonString(Schema.Struct({
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: CommitSha }))
}))

const WorkflowRun = Schema.Struct({
  id: Schema.Int,
  head_sha: CommitSha,
  head_branch: Schema.String,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.NonEmptyString,
  name: Schema.String
})
const WorkflowPages = Schema.fromJsonString(Schema.Array(Schema.Struct({
  workflow_runs: Schema.Array(WorkflowRun)
})))

const watchFolder = (root: string): string => root + "/main-ci"
const readTimeout = Duration.seconds(30)
const redConclusions = new Set(["failure", "timed_out", "action_required", "startup_failure"])

export const watchMainCi = Effect.fnUntraced(function*(root: string, watch: Watch) {
  const fs = yield* FileSystem.FileSystem
  const folder = watchFolder(root)
  yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
  const text = yield* Schema.encodeEffect(Watch)(watch).pipe(
    Effect.mapError((error) => new BacklogError({ detail: "cannot record the main CI watch for " + watch.url + ": " + error.message }))
  )
  yield* publishOnce(folder, watch.task + "." + watch.checkedHead + ".json", text)
})

const readJson = <S extends Schema.Top & { readonly DecodingServices: never }>(args: ReadonlyArray<string>, schema: S) =>
  gh(args).pipe(
    Effect.flatMap((reply) => reply.exitCode === 0
      ? Schema.decodeUnknownEffect(schema)(reply.stdout).pipe(Effect.option)
      : Effect.succeed(Option.none())),
    Effect.catchTag("RunnerError", () => Effect.succeed(Option.none()))
  )

const watchSettled = Effect.fnUntraced(function*(root: string, watch: Watch, at: string) {
  const [, host = "", owner = "", repo = ""] = prPattern.exec(watch.url) ?? []
  const pr = yield* readJson(["pr", "view", watch.url, "--json", "state,mergeCommit"], MergedCommit)
  if (Option.isNone(pr)) {
    return false
  }
  if (pr.value.state === "CLOSED") {
    return true
  }
  if (pr.value.state !== "MERGED" || pr.value.mergeCommit === null) {
    return false
  }
  const sha = pr.value.mergeCommit.oid
  const api = "repos/" + owner + "/" + repo + "/actions/runs?branch=" + encodeURIComponent(watch.branch) + "&event=push&head_sha=" + sha + "&per_page=100"
  const pages = yield* readJson(["api", "--hostname", host, api, "--paginate", "--slurp"], WorkflowPages)
  if (Option.isNone(pages)) {
    return false
  }
  const runs = pages.value.flatMap((page) => page.workflow_runs).filter((run) =>
    run.head_sha === sha && run.head_branch === watch.branch && run.event === "push")
  for (const run of runs) {
    if (run.status === "completed" && run.conclusion !== null && redConclusions.has(run.conclusion)) {
      yield* recordEvent(root, {
        key: watch.task + ".main-ci." + sha + "." + run.id.toString(),
        at,
        text: "CI alarm: " + watch.task + " " + run.name + " failed on " + watch.branch + " at " + sha + " after merging " + watch.url + ". Run: " + run.html_url
      })
    }
  }
  return runs.length > 0 && runs.every((run) => run.status === "completed" && run.conclusion !== null)
})

const pollWatch = Effect.fnUntraced(function*(root: string, file: string, at: string) {
  const text = yield* readIfPresent(file)
  if (text === null) {
    return
  }
  const watch = yield* Schema.decodeEffect(Watch)(text).pipe(
    Effect.mapError((error) => new BacklogError({ detail: file + " holds no main CI watch orc reads: " + error.message }))
  )
  const settled = yield* watchSettled(root, watch, at).pipe(Effect.timeoutOption(readTimeout))
  if (Option.contains(settled, true)) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(file, { force: true }).pipe(Effect.mapError(platformFailure("remove " + file)))
  }
})

export const pollMainCi = (root: string, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> => {
  const folder = watchFolder(root)
  return readNames(folder).pipe(Effect.flatMap((names) =>
    Effect.forEach(names.filter((name) => name.endsWith(".json")), (name) => pollWatch(root, folder + "/" + name, at), { concurrency: 4, discard: true })))
}
