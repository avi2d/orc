import { Duration, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Project } from "../../shared/config/index"
import { capture } from "../../shared/process/index"
import { type BacklogError, platformFailure, publishOnce, readIfPresent } from "../../entities/backlog/index"
import { recordEvent } from "../../entities/events/index"
import { CommitSha, gh, prPattern } from "../../entities/pull-request/index"

const Run = Schema.Struct({
  event: Schema.String,
  url: Schema.NonEmptyString,
  workflow: Schema.Struct({ name: Schema.String })
})
const Suite = Schema.Struct({
  branch: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  workflowRun: Schema.NullOr(Run)
})
const Repository = Schema.Struct({
  defaultBranchRef: Schema.NullOr(Schema.Struct({
    name: Schema.String,
    target: Schema.Struct({
      history: Schema.Struct({
        nodes: Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Struct({
          oid: CommitSha,
          checkSuites: Schema.NullOr(Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.NullOr(Suite))) }))
        }))))
      })
    })
  }))
})
const Reply = Schema.fromJsonString(Schema.Struct({
  data: Schema.Record(Schema.String, Schema.NullOr(Repository))
}))
const Remote = Schema.Struct({
  host: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  repo: Schema.NonEmptyString
})

export type BaseRemote = typeof Remote.Type
export type BaseRepositories = typeof Reply.Type["data"]

export interface ReadBaseCi {
  readonly remote: (checkout: string) => Effect.Effect<Option.Option<BaseRemote>, never, ChildProcessSpawner.ChildProcessSpawner>
  readonly repositories: (host: string, remotes: ReadonlyArray<BaseRemote>) => Effect.Effect<Option.Option<BaseRepositories>, never, ChildProcessSpawner.ChildProcessSpawner>
}

const repositoryKey = (remote: BaseRemote): string => [remote.host, remote.owner, remote.repo].join("/").toLowerCase()

const readTimeout = Duration.seconds(30)
const remotePattern = /^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/
const redConclusions = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])

const bounded = <A, R>(read: Effect.Effect<Option.Option<A>, never, R>) =>
  read.pipe(Effect.timeoutOrElse({ duration: readTimeout, orElse: () => Effect.succeed(Option.none<A>()) }))

const repositoryQuery = (remote: BaseRemote, index: number): string =>
  "r" + String(index) + ": repository(owner: " + JSON.stringify(remote.owner) + ", name: " + JSON.stringify(remote.repo) + ") {" +
  " defaultBranchRef { name target { ... on Commit { history(first: 20) { nodes { oid checkSuites(first: 100) { nodes {" +
  " branch { name } status conclusion updatedAt workflowRun { event url workflow { name } }" +
  " } } } } } } } }"

export const readBaseCi: ReadBaseCi = {
  remote: (checkout) =>
    capture(["git", "-C", checkout, "remote", "get-url", "origin"], null).pipe(
      Effect.flatMap((reply) => {
        const match = reply.exitCode === 0 ? remotePattern.exec(reply.stdout.trim()) : null
        return match === null
          ? Effect.succeed(Option.none())
          : Schema.decodeUnknownEffect(Remote)({ host: match[1], owner: match[2], repo: match[3] }).pipe(Effect.option)
      }),
      Effect.catchTag("RunnerError", () => Effect.succeed(Option.none()))
    ),
  repositories: (host, remotes) =>
    gh(["api", "--hostname", host, "graphql", "-f", "query=query { " + remotes.map(repositoryQuery).join(" ") + " }"]).pipe(
      Effect.flatMap((result) => Schema.decodeEffect(Reply)(result.stdout).pipe(Effect.option)),
      Effect.map(Option.map((reply) => reply.data)),
      Effect.catchTag("RunnerError", () => Effect.succeed(Option.none()))
    )
}

type Branch = NonNullable<NonNullable<typeof Repository.Type>["defaultBranchRef"]>

interface RedRun {
  readonly workflow: string
  readonly sha: string
  readonly url: string
}

const redRuns = (branch: Branch, seen: string): ReadonlyArray<RedRun> =>
  (branch.target.history.nodes ?? []).flatMap((commit, index) => {
    if (commit === null) {
      return []
    }
    return (commit.checkSuites?.nodes ?? []).flatMap((suite) => {
      const run = suite?.workflowRun
      if (suite === null || run === undefined || run === null || run.event !== "push" || suite.branch?.name !== branch.name) {
        return []
      }
      if (suite.status !== "COMPLETED" || suite.conclusion === null || !redConclusions.has(suite.conclusion)) {
        return []
      }
      if (index !== 0 && Date.parse(suite.updatedAt) <= Date.parse(seen)) {
        return []
      }
      return [{ workflow: run.workflow.name, sha: commit.oid, url: run.url }]
    })
  })

const recordAlarm = (root: string, branch: string, run: RedRun, at: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  recordEvent(root, {
    key: "main-ci." + new Bun.CryptoHasher("sha256").update(run.url).digest("hex"),
    at,
    text: "CI alarm: " + run.workflow + " failed on " + branch + " at " + run.sha + ". Run: " + run.url
  })

const priorSight = Effect.fnUntraced(function*(root: string, remote: BaseRemote, at: string) {
  const fs = yield* FileSystem.FileSystem
  const folder = root + "/base-ci"
  yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
  const name = new Bun.CryptoHasher("sha256").update(repositoryKey(remote)).digest("hex") + ".txt"
  const first = yield* publishOnce(folder, name, at)
  return first ? null : yield* readIfPresent(folder + "/" + name)
})

const pollHost = Effect.fnUntraced(function*(root: string, read: ReadBaseCi, host: string, remotes: ReadonlyArray<BaseRemote>, at: string) {
  const repositories = yield* bounded(read.repositories(host, remotes))
  if (Option.isNone(repositories)) {
    return
  }
  for (const [alias, repository] of Object.entries(repositories.value)) {
    const branch = repository?.defaultBranchRef
    const remote = remotes.at(Number(alias.slice(1)))
    if (branch === null || branch === undefined || remote === undefined) {
      continue
    }
    const seen = yield* priorSight(root, remote, at)
    if (seen === null) {
      continue
    }
    for (const run of redRuns(branch, seen)) {
      yield* recordAlarm(root, branch.name, run, at)
    }
  }
})

export const pollBaseCi = Effect.fnUntraced(function*(root: string, read: ReadBaseCi, projects: ReadonlyArray<Project>, pullRequests: ReadonlyArray<string>, at: string) {
  const linked = yield* Effect.forEach(pullRequests, (url) => {
    const [, host, owner, repo] = prPattern.exec(url) ?? []
    return Schema.decodeUnknownEffect(Remote)({ host, owner, repo }).pipe(Effect.option)
  })
  const checkouts = [...new Set(projects.flatMap((project) => Object.values(project.checkouts)))]
  const readings = yield* Effect.forEach(checkouts, (checkout) => bounded(read.remote(checkout)), { concurrency: 4 })
  const unique = new Map([...linked, ...readings].flatMap(Option.toArray).map((remote) => [
    repositoryKey(remote), remote
  ]))
  const hosts = Map.groupBy(unique.values(), (remote) => remote.host.toLowerCase())
  yield* Effect.forEach(hosts, ([host, remotes]) => pollHost(root, read, host, remotes, at), { concurrency: 4, discard: true })
})
