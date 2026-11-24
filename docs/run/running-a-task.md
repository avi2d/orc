---
kind: reference
---
# Running a task

In a clean project checkout, run `orc run <task-file>`.
A ship run creates an isolated worktree, asks Pi to make the change, runs the project's local checks, and opens a PR.

## Before you run

Install `git`, [`nono`](https://nono.sh), `pi`, `node`, and [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) on the host `PATH`.
A `direct-PR` run does not need `no-mistakes`, and `--sandbox none` does not need `nono`.
For no-mistakes delivery, use version 1.90.0 or later.

Configure the provider and models as [Configuring providers](configuring-providers.md) describes.
If the provider uses a Pi login, check it with `pi auth check --provider <id>`.
A key held only in the keychain or an environment variable is not available to the run.
A login Pi's `/login` stores in `~/.pi/agent/auth.json` works, so write a key held only in an environment variable to that file first.
nono reads that login with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TERM` set.
In the sandbox, Pi and the checks get those same variables beside the temp folder, git config and Pi folder orc sets for the run.
On the host they get a short list that adds the shell, the temp folder, `XDG_RUNTIME_DIR` and the proxy and the certificate variables.
No `ORC_` variable reaches Pi or the checks.
With the default sandbox, if nono cannot read the key during the run, its proxy answers Pi with `503 Service Unavailable`, and orc names that error in the result.

Orc refuses a checkout with uncommitted changes or unsafe local git configuration.
Set `ORC_REFUSE_MARKERS` to comma-separated names to reject a marker in the checkout or its parent.

## Local checks and CI

For a ship run, commit a `.no-mistakes.yaml` at the project root with at least one command.
For example:

```yaml
commands:
  lint: bun run lint
```

Orc runs only `build`, `lint`, and `typecheck` as local checks.
In the first checks round, orc prints a warning on stderr naming skipped commands.
The `prepare` command runs before Pi starts and is not skipped.
Without local checks, orc records the round as `skipped`.
Orc then hands off to no-mistakes or opens the direct PR.
GitHub CI runs repository tests and decides completion.
Keep test runners out of those commands and `prepare`.
In Pi sessions, `prepare` and local checks, stand-ins first on `PATH` refuse a test run when it starts, directly or through a script, as [Test runs in agent sessions](heavy-queue.md#test-runs-in-agent-sessions) lists.
A `node` runner started from a Yarn script is not confirmed as refused, as [What is not blocked](heavy-queue.md#what-is-not-blocked) says.
The no-mistakes review runs under the daemon's own `PATH`, so Orc starts no-mistakes with its local Test step skipped.
To refuse test runs in the no-mistakes review and fix agents too, point `agent_path_override` at orc's agent wrapper, as [The no-mistakes review and fix agents](heavy-queue.md#the-no-mistakes-review-and-fix-agents) says.

## Base updates and CI waits

Orc starts no-mistakes without its preflight Rebase step.
An existing task branch keeps its base during the run instead of rebasing just because the base moved.
The no-mistakes CI monitor can still repair a merge conflict.
By default, the monitor leaves clean behind branches alone.
Setting `ci.rebase_behind: true` in `.no-mistakes.yaml` opts into updating them.
When a pull request run exists, Orc tells workers not to start or rerun CI by hand.
Orc manages the wait for CI instead of asking workers to wait in a tool call.

## Choose the run

A ship run uses no-mistakes delivery by default.
To push and open the PR without no-mistakes, add `--delivery direct-PR`.
For a report instead of a PR, add `--kind scout --sandbox none` or `--kind task --sandbox none`.
See [Delivery modes](delivery-modes.md) and [Task kinds](task-kinds.md).

Orc creates `orc/<run-id>` unless you give `--branch <name>`.
The name must pass `git check-ref-format --branch`.
By default Pi runs in a nono sandbox.
Use `--sandbox none` to run Pi and the checks on the host.

Before Pi starts, orc runs the project's `prepare` command in the same sandbox.
If it fails, read `prepare.log` in the run folder.
Pi and the checks use `BUN_OPTIONS=--no-install`.
To give Pi project instructions, add `--instructions <file>`.
Without it, the run sends Pi no project instructions.

## Watch the run

Run `orc runs` to list runs and `orc show <run-id>` to inspect the steps.
See [Seeing runs](seeing-runs.md) for logs and JSON output.
The run folder under `$ORC_HOME/runs/<run-id>` holds the task, agent log, session, evidence, and report.
See [A run](../concepts/run.md) for which runs keep the Pi folder.
When `ORC_HOME` is unset, the folder is under `~/.orc/runs`.
At 300 turns or 5 compactions, an implementation session records a `long-session` warning and writes `handover.md` in the run folder.
The handover names the commits made and why the run stopped, so a later run on the branch can continue from it.

A ship run stops Pi after 45 minutes without output when no tool is running.
Set `ORC_IDLE_TIMEOUT_SECONDS` to a positive whole number to change that limit.
A running tool is not interrupted by the idle limit.

## Answer a review question

To ask each review question for a recommended option, add the `review.path_instructions` entry in [Installing no-mistakes](installing-no-mistakes.md#ask-each-review-question-for-a-recommended-option).

A no-mistakes run waits 30 minutes for an unanswered review question.
Set `ORC_ANSWER_WAIT_SECONDS` to change the wait, or set it to `0` to refuse the gate immediately.
The beat delivers answers from `orc backlog answer`, as [Parked runs](parked-runs.md) describes.
If the wait ends without an answer, the task parks.

To resume a refused gate, pass `--answer question-<id>="<text>"`.
To give no-mistakes guidance for a finding, use `--answer <finding-id>="<text>"`.
Use `--allow ask-user` to decline findings marked exactly `ask-user`.
Findings with any other action still wait as questions.
For another refusal, rerun with `--allow` and the kind named in the report.

## Resume a run

In the same checkout, run `orc run --branch <name>`.
Orc reuses the branch worktree and Pi session and skips steps that already passed.
Include `--delivery direct-PR` again to resume that delivery mode.
A resume uses the recorded sandbox and refuses a different `--sandbox` value.

Orc removes its worktree at the end unless it contains uncommitted changes.
It keeps and names a worktree with uncommitted changes.
It also leaves a reused worktree outside `$ORC_HOME` in place.

## Results

A no-mistakes ship run succeeds when Pi completes with `ORC_COMPLETE` on its own line, the branch has a new commit, the configured local checks pass, and no-mistakes opens the PR and reports green CI.
A direct-PR run succeeds when Pi completes, the branch has a new commit, the configured local checks pass, the PR opens, and the GitHub CI verdict on the pushed head is `passed`.
A `pending` verdict ends the run waiting on CI without success.
The waiting run records an open `ci-waiting` question and keeps its history row running, so the beat parks the task instead of closing it failed or done.
A stopped or failed run exits with status 1 and records the reason.
See [Merging a task's PR](merging-a-tasks-pr.md) for what follows.

## Model and worktree details

Orc loads the implementer agent from `$ORC_HOME/agents/implementer.md`, then the project's `.orc/agents/implementer.md`, then the bundled file.
The fixer agent loads the same way from `fixer.md`.
The reviewer agent file is `$ORC_HOME/agents/reviewer.md`, then the project's `.orc/agents/reviewer.md`, then the bundled `packages/run/agents/reviewer.md`.
The bundled reviewer prints only its findings JSON array, with nothing before or after it and no code fence.
Each finding has `id`, `file`, `line`, `severity`, `action`, and `description`.
An implementer or fixer model comes from its file, its role's model flag, or `config.json`, in that order.
The implementer and the fixer must use a configured provider, and both must use the same provider.
The reviewer runs only in direct-PR delivery, on the fixer model unless its file names a model, and it must use the same provider.
Orc runs the reviewer with read, grep, find, and ls, regardless of the tools named in its agent file.
Orc refuses models absent from Pi or with a context window of 150,000 tokens or less.
Pi compacts context at 150,000 tokens in the default sandbox.
For `--sandbox none` with a Pi login provider, Pi uses your own compaction settings.
With the default sandbox, orc pins each agent model window in `models.json` as that provider model override `contextWindow`.

Orc puts its worktrees under `$ORC_HOME/worktrees/<project>-<hash>/<branch>`, where `<hash>` is the first 8 hex digits of the SHA-256 of the checkout path.
A resumed run can also reuse an older worktree found by Git.
