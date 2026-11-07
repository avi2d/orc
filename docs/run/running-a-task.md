---
kind: reference
---
# Running a task

A run takes one task from `orc run` and a task file.
It makes an isolated copy of the project on a new branch, a git worktree at `$ORC_HOME/worktrees/<project>/<branch>`.
By default it runs the Pi agent inside a nono sandbox, then runs the project's checks.
With `--sandbox none` it runs Pi and the checks directly on the host.
A `no-mistakes` run hands the branch to no-mistakes, which reviews it, pushes it and opens a PR on a provider it supports, such as GitHub.
A `direct-PR` run pushes the branch and opens the PR itself, as [Delivery modes](delivery-modes.md) shows.
You read the PR and land it with `orc merge <task-id>`, as [Merging a task's PR](merging-a-tasks-pr.md) shows.
[The backlog and the beat](backlog-and-beat.md), [Adding tasks from a chat](chat.md) and [The runner](runner.md) describe the path a task takes to its run.

A `ship` run is the default kind.
To open its pull request without no-mistakes, add `--delivery direct-PR`, as [Delivery modes](delivery-modes.md) shows.
To run one, enter a clean git checkout of the target project and run `orc run <task-file>`.
For a `scout` or `task` report instead, add `--kind scout` or `--kind task` with `--sandbox none`, as [Task kinds](task-kinds.md) shows.
Before the first ship task, add a `.no-mistakes.yaml` file to the target project root with at least one named check under `commands`.
Commit that file before running orc.
For example, a project checked by `bun test` keeps this `.no-mistakes.yaml` file.
```yaml
commands:
  test: bun test
```
Replace the command with the project's real check command.
Orc refuses a checkout with uncommitted changes.
Orc commits to a new branch named `orc/<run-id>`, or to the name you pass with `--branch <name>`.
Orc takes any branch name `git check-ref-format --branch` accepts.
To resume the branch after a stop, enter the same target checkout and run `orc run --branch <name>` and orc skips the steps the run history marks passed.
To resume a direct-PR run, add `--delivery direct-PR` to that resume command, and a resume without it runs no-mistakes.
Resume takes the sandbox the earlier run recorded, so a no-sandbox run resumes without a sandbox with no flag.
Orc refuses a resume whose `--sandbox` names another kind than the one recorded.
A run recorded before orc stored the sandbox takes it from the flag, with nono as the default.
On resume orc reuses the copy that holds the branch, wherever git lists it, and Pi resumes its prior session.
A resumed `no-mistakes` run reattaches to no-mistakes with the same intent.
A copy in the project's `.sandcastle/worktrees` folder, made before orc kept copies under `$ORC_HOME`, is reused where it sits and kept when the run ends.
When the run ends, orc removes the copy it made under `$ORC_HOME` unless the copy holds uncommitted changes, which it keeps and names.
After a refusal, run the same resume command with `--allow` and the name from the report, or with `--answer` and your answer for a question.
No-mistakes takes the word for that `--allow` kind, and the answer for that question.
Orc also refuses a checkout whose own git config sets any key outside a short list known to run no program.
To refuse checkouts carrying a marker file, set `ORC_REFUSE_MARKERS` to comma separated marker names.
Orc trims padding around each name and drops blank entries.
Orc checks each marker in the project directory and its parent and refuses a checkout carrying one.
An unset `ORC_REFUSE_MARKERS` names no marker and refuses no checkout for a marker.

Before Pi starts, orc runs the `prepare` command from the copy's `.no-mistakes.yaml`, such as `bun install --frozen-lockfile`, inside the same sandbox as Pi.
A copy without a `prepare` command starts Pi without an install.
Orc refuses the run before Pi starts when the command fails, and its output is in the run folder's `prepare.log`.
Pi and the checks run with `BUN_OPTIONS=--no-install`, so a missing package fails on its import instead of Bun fetching it on the fly.

A `ship` run stops its Pi after 45 minutes with no output and no tool running.
While a tool runs, orc never stops Pi, and the agent log says `still running <command> (N min)` each minute instead.
To change the `ship` limit, set `ORC_IDLE_TIMEOUT_SECONDS` to a whole number of seconds, for example `ORC_IDLE_TIMEOUT_SECONDS=3600 orc run task.md`.
Orc refuses the `ship` run before Pi starts when the value is not a whole number above zero.

To hand the run a project's instructions, add `--instructions <file>`, an absolute path or one relative to the folder you run orc in.
Orc copies the file into the run's `session` folder and adds it to the system prompt of each Pi the run starts.
The run's first line of output names the file, and orc refuses the run before Pi starts when the file is missing.
A run without `--instructions` hands Pi no instructions.

The default sandbox run needs `git`, `nono`, `pi` and `node` on the host PATH, and a run except `direct-PR` needs `no-mistakes` there too.
With `--sandbox none` the run needs the same tools except `nono`.
For every run except `direct-PR`, orc runs `no-mistakes --version` before the sandbox starts and refuses a release older than v1.90.0.
On a provider that takes a Pi login, the run also needs that login in Pi, which `pi auth check --provider <id>` confirms.
With the default sandbox, orc reads that login through Pi on the host and hands it to the sandbox.
nono reads it with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TERM` set, and orc's check runs the same way.
In the sandbox, Pi and the checks get those same variables beside the temp folder, git config and Pi folder orc sets for the run.
On the host they get a short list that adds the shell, the temp folder, the proxy and the certificate variables.
No `ORC_` variable reaches Pi or the checks in either sandbox kind.
So a key held only in the keychain or in an environment variable is refused, and a login Pi's `/login` stores in `~/.pi/agent/auth.json` works.
This refusal applies to `--sandbox none` as well, so write a key held only in an environment variable to the Pi auth file first.
With the default sandbox, if nono cannot read the key during the run, its proxy answers Pi with `503 Service Unavailable`, and orc's result names that error.

Orc takes the implementer agent file from the first of these that exists:

1. `$ORC_HOME/agents/implementer.md`, default `~/.orc/agents/implementer.md` when `ORC_HOME` is unset or empty
1. `.orc/agents/implementer.md` in the project
1. `agents/implementer.md` bundled with orc

An agent file opens with a `---` header naming `thinking`, `tools` and optionally `model`, and its body holds the instructions.
The bundled agent files name no model.
An agent file that names no model takes the one `models` in `config.json` names for its role, and orc refuses a run when neither names one.
Orc runs only a model whose provider `config.json` names, and refuses any other model.
Orc refuses an implementer and a fixer that name models from different providers.

With the default sandbox, Pi in a run compacts its context once the context passes 150 thousand tokens, whatever the model's window.
Pi starts compaction at the window minus `compaction.reserveTokens`, so orc asks the host's Pi for each agent model's window through `pi --mode rpc`.
With the default sandbox, orc writes the window minus 150000 as that model's reserve into the run's Pi folder, `session/agent/settings.json`, beside `models.json`.
With the default sandbox, orc pins each agent model window in `models.json` as that provider model override `contextWindow`.
Orc refuses a model the host's Pi does not list, or one whose window is 150 thousand tokens or less.
That refusal applies to both sandboxes.
With `--sandbox none` on a Pi login provider, Pi reads your Pi config, compaction included, so the fixed mark does not apply.
On a token file or package provider Pi reads the run's own Pi folder, so the mark applies there too.

Once the checks pass, a `no-mistakes` run runs `no-mistakes axi run` on the branch with the task as its intent.
A `direct-PR` run pushes the branch and opens the PR instead, as [Delivery modes](delivery-modes.md) shows.
At each gate orc asks no-mistakes to fix the findings marked `auto-fix`, ignores those marked `no-op`, and accepts the fix review.
Orc refuses a no-mistakes gate holding an open review question without an `--answer` for that question.
Rerun with `--answer question-<id>="<text>"` and orc answers every open question before any gate response.
Orc refuses a no-mistakes gate holding an `ask-user` finding without `--allow ask-user`.
Orc leaves that no-mistakes gate parked for you to answer.

Orc records a `no-mistakes` run as succeeded only when four facts hold.
Pi's final reply in its captured session stopped cleanly with `ORC_COMPLETE` on its own line.
The branch holds at least one new commit.
The project's checks pass.
no-mistakes opened the PR and reported CI green.
A `direct-PR` run succeeds once the first three facts hold and its pull request opens, as [Delivery modes](delivery-modes.md) shows.
Otherwise orc records the run as failed with the reason and exits 1.
Each run keeps its task, evidence, agent log and Pi session in `$ORC_HOME/runs/<run-id>`, default `~/.orc/runs/<run-id>` when `ORC_HOME` is unset or empty.
On a `no-mistakes` run, its `no-mistakes.txt` and the run history hold the no-mistakes findings, their count, the gates orc answered, the final result and the PR link.
They also name the reviewer that served the review, as `axi status` gives it in `reviewer_agent`, or say no-mistakes named none.
Its `report.md` carries the task, the branch, the status, the PR, the steps, the evidence, the signals, the findings and the result.
The terminal report names the run folder, the agent file, the session file and the report as full links, beside the PR link.
A run whose Pi session reaches 300 turns or 5 compactions records a `long-session` warning beside its token signals and writes `handover.md` into the run folder.
The count covers the implementation session only.
The handover names the commits the run made and the reason the run stopped, so the next run on the branch starts from the note instead of the bare task.
A run that loads a handover forwards the copy as `inherited-handover.md`, so a later run still starts fresh only from a run's own note or when no implement session survived.
