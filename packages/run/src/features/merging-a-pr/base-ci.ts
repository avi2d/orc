import { Duration, Effect, Option, Schema } from "effect"
import type { Project } from "../../shared/config/index"
import { capture } from "../../shared/process/index"
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

const readTimeout = Duration.seconds(30)
const remotePattern = /^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/

const readRemote = (checkout: string) =>
  capture(["git", "-C", checkout, "remote", "get-url", "origin"], null).pipe(
    Effect.flatMap((reply) => {
      const match = reply.exitCode === 0 ? remotePattern.exec(reply.stdout.trim()) : null
      return match === null
        ? Effect.succeed(Option.none())
        : Schema.decodeUnknownEffect(Remote)({ host: match[1], owner: match[2], repo: match[3] }).pipe(Effect.option)
    }),
    Effect.catchTag("RunnerError", () => Effect.succeed(Option.none())),
    Effect.timeoutOrElse({ duration: readTimeout, orElse: () => Effect.succeed(Option.none()) })
  )

const repositoryQuery = (remote: typeof Remote.Type, index: number): string =>
  "r" + String(index) + ": repository(owner: " + JSON.stringify(remote.owner) + ", name: " + JSON.stringify(remote.repo) + ") {" +
  " defaultBranchRef { name target { ... on Commit { history(first: 20) { nodes { oid checkSuites(first: 100) { nodes {" +
  " branch { name } status conclusion workflowRun { event url workflow { name } }" +
  " } } } } } } } }"

const pollHost = Effect.fnUntraced(function*(root: string, host: string, remotes: ReadonlyArray<typeof Remote.Type>, at: string) {
  const query = "query { " + remotes.map(repositoryQuery).join(" ") + " }"
  const reply = yield* gh(["api", "--hostname", host, "graphql", "-f", "query=" + query]).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Schema.decodeEffect(Reply)(result.stdout).pipe(Effect.option) : Effect.succeed(Option.none())),
    Effect.catchTag("RunnerError", () => Effect.succeed(Option.none())),
    Effect.timeoutOrElse({ duration: readTimeout, orElse: () => Effect.succeed(Option.none()) })
  )
  if (Option.isNone(reply)) {
    return
  }
  for (const repository of Object.values(reply.value.data)) {
    const branch = repository?.defaultBranchRef
    if (branch === null || branch === undefined) {
      continue
    }
    for (const commit of branch.target.history.nodes ?? []) {
      if (commit === null) {
        continue
      }
      for (const suite of commit.checkSuites?.nodes ?? []) {
        const run = suite?.workflowRun
        if (suite === null || run === undefined || run === null || run.event !== "push" || suite.branch?.name !== branch.name) {
          continue
        }
        yield* recordMainCiAlarm(root, {
          name: run.workflow.name,
          head_sha: commit.oid,
          head_branch: branch.name,
          status: suite.status.toLowerCase(),
          conclusion: suite.conclusion?.toLowerCase() ?? null,
          html_url: run.url
        }, at)
      }
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
    [remote.host, remote.owner, remote.repo].join("/").toLowerCase(), remote
  ]))
  const hosts = Map.groupBy(unique.values(), (remote) => remote.host.toLowerCase())
  yield* Effect.forEach(hosts, ([host, remotes]) => pollHost(root, host, remotes, at), { concurrency: 4, discard: true })
})
