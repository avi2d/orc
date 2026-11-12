import { Effect } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { collectOutput } from "./shared/process/index"
import { hostGitSafetyEnv } from "./shared/sandbox/index"

export interface CommandReply {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface PullRequestOpener {
  readonly push: Effect.Effect<CommandReply>
  readonly existing: Effect.Effect<CommandReply>
  readonly create: (title: string, bodyFile: string) => Effect.Effect<CommandReply>
}

export type DirectPrRecord =
  | { readonly status: "opened"; readonly prLink: string; readonly result: string; readonly started: string; readonly ended: string }
  | { readonly status: "failed"; readonly prLink: null; readonly result: string; readonly started: string; readonly ended: string }

export interface PullRequestHost {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly git: string
  readonly gh: string
  readonly pathEnv: string
  readonly worktreeDir: string
  readonly branch: string
}

const spawnIn = (host: PullRequestHost, binary: string, args: ReadonlyArray<string>): Effect.Effect<CommandReply> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* host.spawner.spawn(ChildProcess.make(binary, [...args], {
      cwd: host.worktreeDir,
      env: { ...hostGitSafetyEnv, PATH: host.git.slice(0, host.git.lastIndexOf("/")) + ":" + host.pathEnv },
      extendEnv: true
    }))
    return yield* collectOutput(handle)
  })).pipe(
    Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: binary + " failed to run: " + String(cause), exitCode: -1 }))
  )

export const subprocessPullRequestOpener = (host: PullRequestHost): PullRequestOpener => ({
  push: spawnIn(host, host.git, ["push", "--set-upstream", "origin", host.branch]),
  existing: spawnIn(host, host.gh, ["pr", "list", "--head", host.branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"]),
  create: (title, bodyFile) => spawnIn(host, host.gh, ["pr", "create", "--head", host.branch, "--title", title, "--body-file", bodyFile])
})

const prUrlIn = (text: string): string | null => /https:\/\/\S+\/pull\/\d+/.exec(text)?.[0] ?? null

const firstLine = (reply: CommandReply): string =>
  (reply.stderr + "\n" + reply.stdout).split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "exit " + reply.exitCode.toString()

export const openDirectPr = (opener: PullRequestOpener, branch: string, title: string, bodyFile: string): Effect.Effect<DirectPrRecord> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    const failed = (result: string): DirectPrRecord => ({ status: "failed", prLink: null, result: result + " No PR opens.", started, ended: new Date().toISOString() })
    const pushed = yield* opener.push
    if (pushed.exitCode !== 0) {
      return failed("git push of " + branch + " failed: " + firstLine(pushed) + ".")
    }
    const existing = yield* opener.existing
    const known = existing.exitCode === 0 ? prUrlIn(existing.stdout) : null
    if (known !== null) {
      return { status: "opened", prLink: known, result: "orc pushed " + branch + " to the open PR " + known + ".", started, ended: new Date().toISOString() }
    }
    const created = yield* opener.create(title, bodyFile)
    const link = created.exitCode === 0 ? prUrlIn(created.stdout) : null
    if (link === null) {
      return failed("gh pr create for " + branch + " failed: " + firstLine(created) + ".")
    }
    return { status: "opened", prLink: link, result: "orc pushed " + branch + " and opened " + link + ".", started, ended: new Date().toISOString() }
  })
