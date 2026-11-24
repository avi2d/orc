import { Duration, Effect, FileSystem, Option, Schema } from "effect"
import type { Project } from "../../shared/config/index"
import { capture, type RunnerError } from "../../shared/process/index"
import { platformFailure, publishOnce, readIfPresent } from "../../entities/backlog/index"
import { CommitSha, gh, prPattern } from "../../entities/pull-request/index"
import { recordMainCiAlarm } from "./main-ci"

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

const repositoryKey = (remote: typeof Remote.Type): string => [remote.host, remote.owner, remote.repo].join("/").toLowerCase()

const readTimeout = Duration.seconds(30)
const remotePattern = /^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/

const orNone = <A, R>(read: Effect.Effect<Option.Option<A>, RunnerError, R>) =>
  read.pipe(
    Effect.catchTag("RunnerError", () => Effect.succeed(Option.none<A>())),
    Effect.timeoutOrElse({ duration: readTimeout, orElse: () => Effect.succeed(Option.none<A>()) })
  )

const readRemote = (checkout: string) =>
  capture(["git", "-C", checkout, "remote", "get-url", "origin"], null).pipe(
    Effect.flatMap((reply) => {
      const match = reply.exitCode === 0 ? remotePattern.exec(reply.stdout.trim()) : null
      return match === null
        ? Effect.succeed(Option.none())
        : Schema.decodeUnknownEffect(Remote)({ host: match[1], owner: match[2], repo: match[3] }).pipe(Effect.option)
    })
  ).pipe(orNone)

const repositoryQuery = (remote: typeof Remote.Type, index: number): string =>
  "r" + String(index) + ": repository(owner: " + JSON.stringify(remote.owner) + ", name: " + JSON.stringify(remote.repo) + ") {" +
  " defaultBranchRef { name target { ... on Commit { history(first: 20) { nodes { oid checkSuites(first: 100) { nodes {" +
  " branch { name } status conclusion updatedAt workflowRun { event url workflow { name } }" +
  " } } } } } } } }"

type Branch = NonNullable<NonNullable<typeof Repository.Type>["defaultBranchRef"]>

const afterFirstSight = (suite: typeof Suite.Type, seen: string): boolean => Date.parse(suite.updatedAt) > Date.parse(seen)

const alarmRuns = (branch: Branch, seen: string): ReadonlyArray<Parameters<typeof recordMainCiAlarm>[1]> =>
  (branch.target.history.nodes ?? []).flatMap((commit, index) => {
    if (commit === null) {
      return []
    }
    return (commit.checkSuites?.nodes ?? []).flatMap((suite) => {
      const run = suite?.workflowRun
      if (suite === null || run === undefined || run === null || run.event !== "push" || suite.branch?.name !== branch.name) {
        return []
      }
      if (index !== 0 && !afterFirstSight(suite, seen)) {
        return []
      }
      return [{
        name: run.workflow.name,
        head_sha: commit.oid,
        head_branch: branch.name,
        status: suite.status.toLowerCase(),
        conclusion: suite.conclusion?.toLowerCase() ?? null,
        html_url: run.url
      }]
    })
  })

const priorSight = Effect.fnUntraced(function*(root: string, remote: typeof Remote.Type, at: string) {
  const fs = yield* FileSystem.FileSystem
  const folder = root + "/base-ci"
  yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
  const name = new Bun.CryptoHasher("sha256").update(repositoryKey(remote)).digest("hex") + ".txt"
  const first = yield* publishOnce(folder, name, at)
  return first ? null : yield* readIfPresent(folder + "/" + name)
})

const readReply = (host: string, remotes: ReadonlyArray<typeof Remote.Type>) =>
  gh(["api", "--hostname", host, "graphql", "-f", "query=query { " + remotes.map(repositoryQuery).join(" ") + " }"]).pipe(
    Effect.flatMap((result) => Schema.decodeEffect(Reply)(result.stdout).pipe(Effect.option))
  ).pipe(orNone)

const pollHost = Effect.fnUntraced(function*(root: string, host: string, remotes: ReadonlyArray<typeof Remote.Type>, at: string) {
  const reply = yield* readReply(host, remotes)
  if (Option.isNone(reply)) {
    return
  }
  for (const [alias, repository] of Object.entries(reply.value.data)) {
    const branch = repository?.defaultBranchRef
    const remote = remotes.at(Number(alias.slice(1)))
    if (branch === null || branch === undefined || remote === undefined) {
      continue
    }
    const seen = yield* priorSight(root, remote, at)
    if (seen === null) {
      continue
    }
    for (const run of alarmRuns(branch, seen)) {
      yield* recordMainCiAlarm(root, run, at)
    }
  }
})

export const pollBaseCi = Effect.fnUntraced(function*(root: string, projects: ReadonlyArray<Project>, pullRequests: ReadonlyArray<string>, at: string) {
  const linked = yield* Effect.forEach(pullRequests, (url) => {
    const [, host, owner, repo] = prPattern.exec(url) ?? []
    return Schema.decodeUnknownEffect(Remote)({ host, owner, repo }).pipe(Effect.option)
  })
  const checkouts = [...new Set(projects.flatMap((project) => Object.values(project.checkouts)))]
  const readings = yield* Effect.forEach(checkouts, readRemote, { concurrency: 4 })
  const unique = new Map([...linked, ...readings].flatMap(Option.toArray).map((remote) => [
    repositoryKey(remote), remote
  ]))
  const hosts = Map.groupBy(unique.values(), (remote) => remote.host.toLowerCase())
  yield* Effect.forEach(hosts, ([host, remotes]) => pollHost(root, host, remotes, at), { concurrency: 4, discard: true })
})
