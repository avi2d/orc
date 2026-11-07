import { Duration, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { hostGitRefusalExit, hostGitSafetyEnv, hostGitShim } from "../host"
import { parseRefuseMarkers } from "../checkout"
import { legacyCopiesExcluded } from "../task-copy"

export type Refresh =
  | { readonly kind: "fast-forwarded"; readonly branch: string; readonly remote: string; readonly from: string; readonly to: string }
  | { readonly kind: "current"; readonly branch: string; readonly remote: string; readonly at: string }
  | { readonly kind: "kept"; readonly reason: string }

type Kept = Extract<Refresh, { readonly kind: "kept" }>

type Requirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// The far side of a forwarded start gets 30 seconds before the dispatcher gives up on it, so the fetch must end well inside that.
const fetchSeconds = 20

const gitEnv = { ...hostGitSafetyEnv, GIT_TERMINAL_PROMPT: "0" }

const git = (gitBin: string, projectDir: string, args: ReadonlyArray<string>): Effect.Effect<GitResult, never, Requirements> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(gitBin, [...args], { cwd: projectDir, env: gitEnv, extendEnv: true, stdin: "ignore" }))
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

const refused = (result: GitResult): Kept | null =>
  result.exitCode === hostGitRefusalExit ? kept(firstLine(result.stderr)) : null

const uncommittedChanges = (count: number): string => count.toString() + (count === 1 ? " uncommitted change" : " uncommitted changes")

const refusedMarker = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  projectDir: string
): Effect.Effect<Kept | null> =>
  Effect.gen(function*() {
    for (const marker of parseRefuseMarkers(Bun.env.ORC_REFUSE_MARKERS)) {
      for (const candidate of [path.join(projectDir, marker), path.join(path.dirname(projectDir), marker)]) {
        const found = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
        if (found) {
          return kept(candidate + " marks this checkout as refused")
        }
      }
    }
    return null
  })

const cleanBranch = (gitBin: string, projectDir: string): Effect.Effect<{ readonly branch: string } | Kept, never, Requirements> =>
  Effect.gen(function*() {
    const inside = yield* git(gitBin, projectDir, ["rev-parse", "--is-inside-work-tree"])
    const stopInside = refused(inside)
    if (stopInside !== null) {
      return stopInside
    }
    if (inside.exitCode !== 0 || inside.stdout !== "true") {
      return kept("it is no git checkout")
    }
    const head = yield* git(gitBin, projectDir, ["symbolic-ref", "--quiet", "HEAD"])
    const stopHead = refused(head)
    if (stopHead !== null) {
      return stopHead
    }
    if (head.exitCode !== 0) {
      return kept("it is on no branch")
    }
    const status = yield* git(gitBin, projectDir, ["status", "--porcelain", "--", ".", legacyCopiesExcluded])
    if (status.exitCode !== 0) {
      return kept("git status failed: " + firstLine(status.stderr))
    }
    const changes = status.stdout.split("\n").filter((line) => line.trim() !== "").length
    const fullRef = head.stdout
    const headsPrefix = "refs/heads/"
    return changes > 0 ? kept("it holds " + uncommittedChanges(changes)) : { branch: fullRef.startsWith(headsPrefix) ? fullRef.slice(headsPrefix.length) : fullRef }
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

const fetchRemote = (gitBin: string, projectDir: string, remote: string): Effect.Effect<Kept | null, never, Requirements> =>
  git(gitBin, projectDir, ["-c", "remote." + remote + ".followRemoteHEAD=always", "fetch", "--quiet", "--no-recurse-submodules", remote]).pipe(
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

const fetchedTip = (gitBin: string, projectDir: string): Effect.Effect<RemoteTip | Kept, never, Requirements> =>
  Effect.gen(function*() {
    const listed = yield* git(gitBin, projectDir, ["remote"])
    const stopListed = refused(listed)
    if (stopListed !== null) {
      return stopListed
    }
    const picked = pickRemote(listed.stdout)
    if ("kind" in picked) {
      return picked
    }
    const remote = picked.remote
    const fetchFailure = yield* fetchRemote(gitBin, projectDir, remote)
    if (fetchFailure !== null) {
      return fetchFailure
    }
    const remoteHead = yield* git(gitBin, projectDir, ["symbolic-ref", "--quiet", "refs/remotes/" + remote + "/HEAD"])
    const stopHead = refused(remoteHead)
    if (stopHead !== null) {
      return stopHead
    }
    if (remoteHead.exitCode !== 0) {
      return kept(remote + " names no default branch, which git remote set-head " + remote + " --auto records")
    }
    const target = remoteHead.stdout
    const namespace = "refs/remotes/" + remote + "/"
    if (!target.startsWith(namespace)) {
      return kept(remote + " names no default branch, which git remote set-head " + remote + " --auto records")
    }
    const tracking = remote + "/" + target.slice(namespace.length)
    const resolved = yield* git(gitBin, projectDir, ["rev-parse", "--verify", "--quiet", target])
    const stopResolved = refused(resolved)
    if (stopResolved !== null) {
      return stopResolved
    }
    const tip = resolved.stdout
    return tip === "" ? kept(tracking + " names no commit") : { remote, tracking, defaultBranch: tracking.slice(remote.length + 1), tip }
  })

const fastForward = (gitBin: string, projectDir: string, branch: string, remote: RemoteTip): Effect.Effect<Refresh, never, Requirements> =>
  Effect.gen(function*() {
    const localResult = yield* git(gitBin, projectDir, ["rev-parse", "HEAD"])
    const stopLocal = refused(localResult)
    if (stopLocal !== null) {
      return stopLocal
    }
    const local = localResult.stdout
    if (local === remote.tip) {
      return { kind: "current", branch, remote: remote.remote, at: short(local) } satisfies Refresh
    }
    const behind = yield* git(gitBin, projectDir, ["merge-base", "--is-ancestor", "HEAD", remote.tip])
    if (behind.exitCode !== 0) {
      const ahead = yield* git(gitBin, projectDir, ["merge-base", "--is-ancestor", remote.tip, "HEAD"])
      return kept(ahead.exitCode === 0 ? branch + " holds commits " + remote.tracking + " lacks" : branch + " has diverged from " + remote.tracking)
    }
    const merged = yield* git(gitBin, projectDir, ["merge", "--ff-only", "--quiet", "--no-overwrite-ignore", remote.tip])
    if (merged.exitCode !== 0) {
      return kept("git merge --ff-only " + remote.tracking + " failed: " + firstLine(merged.stderr))
    }
    return { kind: "fast-forwarded", branch, remote: remote.remote, from: short(local), to: short(remote.tip) } satisfies Refresh
  })

// Only a fast-forward of the checked-out default branch with a clean tree moves anything, so no local commit or change is ever lost.
export const refreshCheckout = (projectDir: string): Effect.Effect<Refresh, never, Requirements> =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const marked = yield* refusedMarker(fs, path, projectDir)
    if (marked !== null) {
      return marked
    }
    const shim = yield* hostGitShim(fs, path, Bun.which("git") ?? "git").pipe(Effect.orElseSucceed(() => null))
    if (shim === null) {
      return kept("cannot write the host git shim")
    }
    const local = yield* cleanBranch(shim, projectDir)
    if ("kind" in local) {
      return local
    }
    const remote = yield* fetchedTip(shim, projectDir)
    if ("kind" in remote) {
      return remote
    }
    if (local.branch !== remote.defaultBranch) {
      return kept("it is on " + local.branch + ", not the default branch " + remote.defaultBranch)
    }
    return yield* fastForward(shim, projectDir, local.branch, remote)
  }))

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
