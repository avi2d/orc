import { Effect } from "effect"
import { runGit } from "../../shared/process/index"
import { OrcRunError } from "../../shared/lib/index"
import { failedReport, type HistoryRun } from "./run-record"
import type { PullRequestOpener } from "../../entities/pull-request/index"

export const rebaseDelivery = Effect.fnUntraced(function*(run: HistoryRun, opener: PullRequestOpener) {
  const git = (args: ReadonlyArray<string>) => runGit(run.spawner, run.git, args, run.worktreeDir)
  const current = yield* git(["branch", "--show-current"])
  if (current.exitCode !== 0 || current.stdout.trim() !== run.branch) {
    return yield* new OrcRunError({ message: "orc: cannot rebase " + run.branch + ": the worktree is not on that branch" })
  }
  const fetched = yield* opener.fetch
  if (fetched.exitCode !== 0) {
    return yield* new OrcRunError({ message: "orc: cannot fetch origin before delivery: " + fetched.stderr.trim() })
  }
  const head = yield* git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  const base = head.stdout.trim()
  if (head.exitCode !== 0 || !base.startsWith("refs/remotes/origin/")) {
    return yield* new OrcRunError({ message: "orc: origin names no default branch; run git remote set-head origin --auto" })
  }
  const config = run.piSessionDir + "/gitconfig"
  const name = yield* git(["config", "--file", config, "--get", "user.name"])
  const email = yield* git(["config", "--file", config, "--get", "user.email"])
  const identity = name.exitCode === 0 && email.exitCode === 0
    ? ["-c", "user.name=" + name.stdout.trim(), "-c", "user.email=" + email.stdout.trim()]
    : []
  const rebased = yield* git([...identity, "rebase", base])
  if (rebased.exitCode !== 0) {
    yield* git(["rebase", "--abort"]).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })))
    return yield* new OrcRunError({ message: "orc: cannot rebase " + run.branch + " onto " + base + ": " + rebased.stderr.trim() })
  }
})

const pushRebase = Effect.fnUntraced(function*(run: HistoryRun, head: string) {
  const pushed = yield* runGit(run.spawner, run.git, ["push", "--force-with-lease=refs/heads/" + run.branch + ":" + head, "origin", run.branch], run.worktreeDir)
  if (pushed.exitCode !== 0) {
    return yield* new OrcRunError({ message: "orc: cannot push rebased " + run.branch + ": " + pushed.stderr.trim() })
  }
})

export const runRebase = Effect.fnUntraced(function*(run: HistoryRun, rebase: NonNullable<HistoryRun["rebase"]>) {
  if (run.delivery.kind !== "orc") {
    return yield* new OrcRunError({ message: "orc: a rebase run needs orc delivery" })
  }
  const current = yield* runGit(run.spawner, run.git, ["rev-parse", "HEAD"], run.worktreeDir)
  if (current.exitCode !== 0 || current.stdout.trim() !== rebase.head) {
    return yield* new OrcRunError({ message: "orc: cannot rebase " + run.branch + ": its local head differs from the observed PR head" })
  }
  yield* rebaseDelivery(run, run.delivery.opener)
  yield* pushRebase(run, rebase.head)
  return { ...failedReport(run, "Rebased and pushed the existing PR branch."), completed: true, prLink: rebase.pr }
})
