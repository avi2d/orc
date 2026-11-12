import { Duration, Effect, FileSystem, Option, Result, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { addTask } from "./backlog"
import { BacklogError, platformFailure, readIfPresent, scratchName } from "./backlog-write"
import type { BeatAction } from "./beat-action"
import { type Contribution, contributionId, type Project } from "../shared/config/index"
import { recordEvent } from "./events"
import { gh } from "./pr-view"
import type { RunnerError } from "../shared/process/index"

const IssueState = Schema.Struct({
  kind: Schema.Literal("issue"),
  state: Schema.Literals(["OPEN", "CLOSED"]),
  comments: Schema.Int
})
const PullState = Schema.Struct({
  kind: Schema.Literal("pull"),
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  comments: Schema.Int,
  reviews: Schema.Int,
  head: Schema.String
})
const UpstreamState = Schema.Union([IssueState, PullState])
export type UpstreamState = typeof UpstreamState.Type

export type ReadUpstream = (contribution: Contribution) => Effect.Effect<UpstreamState, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner>

const Count = Schema.Struct({ totalCount: Schema.Int })
const GraphqlReply = Schema.fromJsonString(Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issueOrPullRequest: Schema.Union([
        Schema.Struct({ type: Schema.Literal("Issue"), state: IssueState.fields.state, comments: Count }),
        Schema.Struct({ type: Schema.Literal("PullRequest"), state: PullState.fields.state, headRefOid: Schema.String, comments: Count, reviews: Count })
      ])
    })
  })
}))

const query = "query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issueOrPullRequest(number: $number) { " +
  "type: __typename ... on Issue { state comments { totalCount } } ... on PullRequest { state headRefOid comments { totalCount } reviews { totalCount } } } } }"

// gh api -F reads a value starting with @ as a file and a numeric one as a number, so the owner and repository go through -f.
export const readUpstream: ReadUpstream = (contribution) =>
  Effect.gen(function*() {
    const asked = yield* gh(["api", "graphql", "-f", "query=" + query, "-f", "owner=" + contribution.owner, "-f", "repo=" + contribution.repo, "-F", "number=" + String(contribution.number)])
    if (asked.exitCode !== 0) {
      return yield* new BacklogError({ detail: "cannot read " + contribution.url + ": " + asked.said })
    }
    const reply = yield* Schema.decodeEffect(GraphqlReply)(asked.stdout).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read " + contribution.url + ": gh printed no issue or pull request orc reads: " + error.message }))
    )
    const item = reply.data.repository.issueOrPullRequest
    return item.type === "Issue"
      ? { kind: "issue", state: item.state, comments: item.comments.totalCount } satisfies UpstreamState
      : { kind: "pull", state: item.state, comments: item.comments.totalCount, reviews: item.reviews.totalCount, head: item.headRefOid } satisfies UpstreamState
  })

const counted = (count: number, word: string): string => String(count) + " " + word + (count === 1 ? "" : "s")

const countChange = (before: number, after: number, word: string): ReadonlyArray<string> =>
  after > before ? [counted(after - before, "new " + word)] : after < before ? [counted(before - after, word) + " gone"] : []

const stateChange = (before: UpstreamState["state"], after: UpstreamState["state"]): ReadonlyArray<string> =>
  before === after ? [] : [after === "MERGED" ? "merged" : after === "CLOSED" ? "closed" : "reopened"]

export const changesOf = (before: UpstreamState, after: UpstreamState): ReadonlyArray<string> => {
  const common = [...stateChange(before.state, after.state), ...countChange(before.comments, after.comments, "comment")]
  if (before.kind !== "pull" || after.kind !== "pull") {
    return before.kind === after.kind ? common : [...common, "now reads as " + (after.kind === "pull" ? "a pull request" : "an issue")]
  }
  return [...common, ...countChange(before.reviews, after.reviews, "review"), ...(before.head === after.head ? [] : ["new head " + after.head.slice(0, 7)])]
}

const describeState = (state: UpstreamState): string =>
  [state.state.toLowerCase(), counted(state.comments, "comment"), ...(state.kind === "pull" ? [counted(state.reviews, "review"), "head " + state.head.slice(0, 7)] : [])].join(", ")

const Seen = Schema.fromJsonString(Schema.Struct({ url: Schema.String, state: UpstreamState, changes: Schema.Int }))
type Seen = typeof Seen.Type

const seenFolder = (root: string, project: string): string => root + "/upstream/" + project

const seenFile = (root: string, project: string, contribution: Contribution): string =>
  seenFolder(root, project) + "/" + contributionId(contribution) + ".json"

const readSeen = (file: string): Effect.Effect<Seen | null, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const text = yield* readIfPresent(file)
    if (text === null) {
      return null
    }
    return yield* Schema.decodeEffect(Seen)(text).pipe(
      Effect.mapError((error) => new BacklogError({ detail: file + " holds no upstream state orc reads, so remove it to watch afresh: " + error.message }))
    )
  })

const writeSeen = (root: string, project: string, contribution: Contribution, seen: Seen): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = seenFolder(root, project)
    const file = seenFile(root, project, contribution)
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
    const text = yield* Schema.encodeEffect(Seen)(seen).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot write " + file + ": " + error.message }))
    )
    const scratch = scratchName(folder, contributionId(contribution))
    yield* fs.writeFileString(scratch, text).pipe(Effect.mapError(platformFailure("write " + scratch)))
    yield* fs.rename(scratch, file).pipe(Effect.mapError(platformFailure("write " + file)))
  })

const shortName = (contribution: Contribution): string => contribution.owner + "/" + contribution.repo + "#" + String(contribution.number)

const noun = (state: UpstreamState): string => state.kind === "pull" ? "pull request" : "issue"

const scoutBody = (project: string, contribution: Contribution, state: UpstreamState, title: string, changes: ReadonlyArray<string>): string =>
  [
    "# " + title,
    "",
    "The upstream " + noun(state) + " " + contribution.url + ", which projects.json names for " + project + ", changed since the last beat read it: " + changes.join(", ") + ".",
    "It now reads " + describeState(state) + ".",
    "",
    "Read it and what changed on it with gh, and report what changed and what " + project + " should do next.",
    "Change nothing upstream: post no comment or review, push nothing and open nothing there.",
    ""
  ].join("\n")

// The key holds the change number and both states, so beats reading one change share one key, and a record removed and seen afresh meets no old key.
const changeKey = (project: string, contribution: Contribution, seen: Seen, state: UpstreamState): string =>
  "upstream." + new Bun.CryptoHasher("sha256").update([project, contributionId(contribution), String(seen.changes), JSON.stringify(seen.state), JSON.stringify(state)].join("\0")).digest("hex").slice(0, 16)

const upstreamSeconds = 30

type Requirements = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

const timedRead = (read: ReadUpstream, contribution: Contribution) =>
  read(contribution).pipe(
    Effect.result,
    Effect.timeoutOrElse({
      duration: Duration.seconds(upstreamSeconds),
      orElse: () => Effect.succeed(Result.fail(new BacklogError({ detail: "cannot read " + contribution.url + ": the read timed out after " + upstreamSeconds + " seconds" })))
    })
  )

const watchOne = (
  root: string,
  project: string,
  contribution: Contribution,
  read: ReadUpstream,
  at: string
): Effect.Effect<Option.Option<BeatAction>, BacklogError, Requirements> =>
  Effect.gen(function*() {
    const unread = (reason: string) => Option.some<BeatAction>({ kind: "upstream-unread", project, url: contribution.url, reason })
    const seen = yield* readSeen(seenFile(root, project, contribution)).pipe(Effect.result)
    if (Result.isFailure(seen)) {
      return unread(seen.failure.detail)
    }
    const now = yield* timedRead(read, contribution)
    if (Result.isFailure(now)) {
      return unread(now.failure.detail)
    }
    const state = now.success
    if (seen.success === null) {
      yield* writeSeen(root, project, contribution, { url: contribution.url, state, changes: 0 })
      return Option.some<BeatAction>({ kind: "upstream-seen", project, url: contribution.url, state: describeState(state) })
    }
    const before = seen.success
    const changes = changesOf(before.state, state)
    if (changes.length === 0) {
      return Option.none()
    }
    const title = "Follow up on " + shortName(contribution) + ": " + changes.join(", ")
    // The event is claimed before the task is added, so of two beats reading one change only the one that claims it adds the task.
    const claimed = yield* recordEvent(root, { key: changeKey(project, contribution, before, state), at, text: "upstream " + contribution.url + " of " + project + " changed: " + changes.join(", ") })
    const task = claimed
      ? yield* addTask(root, { title, project, kind: "scout", internal: false, machine: null, parent: null, split: null, dependsOn: [], created: at, body: scoutBody(project, contribution, state, title, changes) })
      : null
    yield* writeSeen(root, project, contribution, { url: contribution.url, state, changes: before.changes + 1 })
    return task === null ? Option.none() : Option.some<BeatAction>({ kind: "upstream-changed", project, url: contribution.url, changes, task: task.spec.id })
  })

export const watchUpstream = (
  root: string,
  projects: ReadonlyArray<Project>,
  read: ReadUpstream,
  at: string
): Effect.Effect<ReadonlyArray<BeatAction>, BacklogError, Requirements> =>
  Effect.forEach(
    projects.flatMap((project) => (project.upstream ?? []).map((contribution) => ({ project: project.name, contribution }))),
    (entry) => watchOne(root, entry.project, entry.contribution, read, at)
  ).pipe(Effect.map((actions) => actions.flatMap(Option.toArray)))
