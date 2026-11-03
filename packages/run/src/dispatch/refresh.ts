import { Duration, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { hostGitSafetyEnv } from "../host"

export type Refresh =
  | { readonly kind: "fast-forwarded"; readonly branch: string; readonly remote: string; readonly from: string; readonly to: string }
  | { readonly kind: "current"; readonly branch: string; readonly remote: string; readonly at: string }
  | { readonly kind: "kept"; readonly reason: string }

type Kept = Extract<Refresh, { readonly kind: "kept" }>

type Requirements = ChildProcessSpawner.ChildProcessSpawner

interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// The far side of a forwarded start gets 30 seconds before the dispatcher gives up on it, so the fetch must end well inside that.
const fetchSeconds = 20

const gitEnv = { ...hostGitSafetyEnv, GIT_TERMINAL_PROMPT: "0" }

const git = (projectDir: string, args: ReadonlyArray<string>): Effect.Effect<GitResult, never, Requirements> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", [...args], { cwd: projectDir, env: gitEnv, extendEnv: true, stdin: "ignore" }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.succeed({ exitCode: -1, stdout: "", stderr: "git did not run: " + error.message }))
  )

const firstLine = (text: string): string => text.split("\n")[0] ?? ""

const short = (sha: string): string => sha.slice(0, 7)

const kept = (reason: string): Kept => ({ kind: "kept", reason })

const uncommittedChanges = (count: number): string => count.toString() + (count === 1 ? " uncommitted change" : " uncommitted changes")

const cleanBranch = (projectDir: string): Effect.Effect<{ readonly branch: string } | Kept, never, Requirements> =>
  Effect.gen(function*() {
    const inside = yield* git(projectDir, ["rev-parse", "--is-inside-work-tree"])
    if (inside.exitCode !== 0 || inside.stdout !== "true") {
      return kept("it is no git checkout")
    }
    const head = yield* git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (head.exitCode !== 0) {
      return kept("it is on no branch")
    }
    const status = yield* git(projectDir, ["status", "--porcelain", "--", ".", ":(exclude).sandcastle/worktrees"])
    if (status.exitCode !== 0) {
      return kept("git status failed: " + firstLine(status.stderr))
    }
    const changes = status.stdout.split("\n").filter((line) => line.trim() !== "").length
    return changes > 0 ? kept("it holds " + uncommittedChanges(changes)) : { branch: head.stdout }
  })

const pickRemote = (listed: string): { readonly remote: string } | Kept => {
  const remotes = listed.split("\n").filter((name) => name !== "")
  if (remotes.includes("origin")) {
    return { remote: "origin" }
  }
  if (remotes.length === 0) {
    return kept("it has no remote")
  }
  return remotes.length === 1 ? { remote: remotes.join("") } : kept("it has several remotes and none named origin")
}

const fetchRemote = (projectDir: string, remote: string): Effect.Effect<Kept | null, never, Requirements> =>
  git(projectDir, ["fetch", "--quiet", "--no-recurse-submodules", remote]).pipe(
    Effect.map((fetched) => fetched.exitCode === 0 ? null : kept("git fetch " + remote + " failed: " + firstLine(fetched.stderr))),
    Effect.timeoutOrElse({
      duration: Duration.seconds(fetchSeconds),
      orElse: () => Effect.succeed(kept("git fetch " + remote + " ran past " + fetchSeconds + " seconds"))
    })
  )

interface RemoteTip {
  readonly remote: string
  readonly tracking: string
  readonly defaultBranch: string
  readonly tip: string
}

const fetchedTip = (projectDir: string): Effect.Effect<RemoteTip | Kept, never, Requirements> =>
  Effect.gen(function*() {
    const picked = pickRemote((yield* git(projectDir, ["remote"])).stdout)
    if ("kind" in picked) {
      return picked
    }
    const remote = picked.remote
    const fetchFailure = yield* fetchRemote(projectDir, remote)
    if (fetchFailure !== null) {
      return fetchFailure
    }
    const remoteHead = yield* git(projectDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/" + remote + "/HEAD"])
    if (remoteHead.exitCode !== 0) {
      return kept(remote + " names no default branch, which git remote set-head " + remote + " --auto records")
    }
    const tracking = remoteHead.stdout
    const tip = (yield* git(projectDir, ["rev-parse", "--verify", "--quiet", tracking])).stdout
    return tip === "" ? kept(tracking + " names no commit") : { remote, tracking, defaultBranch: tracking.slice(remote.length + 1), tip }
  })

const fastForward = (projectDir: string, branch: string, remote: RemoteTip): Effect.Effect<Refresh, never, Requirements> =>
  Effect.gen(function*() {
    const local = (yield* git(projectDir, ["rev-parse", "HEAD"])).stdout
    if (local === remote.tip) {
      return { kind: "current", branch, remote: remote.remote, at: short(local) } satisfies Refresh
    }
    const behind = yield* git(projectDir, ["merge-base", "--is-ancestor", "HEAD", remote.tip])
    if (behind.exitCode !== 0) {
      const ahead = yield* git(projectDir, ["merge-base", "--is-ancestor", remote.tip, "HEAD"])
      return kept(ahead.exitCode === 0 ? branch + " holds commits " + remote.tracking + " lacks" : branch + " has diverged from " + remote.tracking)
    }
    const merged = yield* git(projectDir, ["merge", "--ff-only", "--quiet", remote.tip])
    if (merged.exitCode !== 0) {
      return kept("git merge --ff-only " + remote.tracking + " failed: " + firstLine(merged.stderr))
    }
    return { kind: "fast-forwarded", branch, remote: remote.remote, from: short(local), to: short(remote.tip) } satisfies Refresh
  })

// Only a fast-forward of the checked-out default branch with a clean tree moves anything, so no local commit or change is ever lost.
export const refreshCheckout = (projectDir: string): Effect.Effect<Refresh, never, Requirements> =>
  Effect.gen(function*() {
    const local = yield* cleanBranch(projectDir)
    if ("kind" in local) {
      return local
    }
    const remote = yield* fetchedTip(projectDir)
    if ("kind" in remote) {
      return remote
    }
    if (local.branch !== remote.defaultBranch) {
      return kept("it is on " + local.branch + ", not the default branch " + remote.defaultBranch)
    }
    return yield* fastForward(projectDir, local.branch, remote)
  })

export const formatRefresh = (projectDir: string, refresh: Refresh): string => {
  switch (refresh.kind) {
    case "fast-forwarded":
      return "fast-forwarded " + refresh.branch + " in " + projectDir + " from " + refresh.from + " to " + refresh.to + " on " + refresh.remote
    case "current":
      return refresh.branch + " in " + projectDir + " is current with " + refresh.remote + " at " + refresh.at
    case "kept":
      return "did not refresh " + projectDir + " because " + refresh.reason + ", so the run starts from what it holds"
  }
}
