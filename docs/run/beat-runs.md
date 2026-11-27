---
kind: reference
---
# The beat and task runs

Run `orc beat` every few minutes from launchd or cron to start eligible tasks and close finished runs.
The beat has no dry-run option.
To inspect tasks and the last recorded wait reasons without starting work, run `orc backlog`, as [Inspect the backlog](backlog-tasks.md#inspect-the-backlog) describes.

## Start tasks with the beat

A task starts when it has a priority, no unanswered hold or question, and its dependencies are done.
A ship prerequisite must also have its PR merged.
No beat reopens a closed task, so a prerequisite that closed failed, stopped, start-failed or dropped holds its dependents until you change their dependencies with `orc backlog depend`.
Their wait names it, as in `waits on orc-2, and orc-2 closed failed, which no beat reopens`.
A failed, stopped or start-failed prerequisite also stops holding them once `orc backlog retry` runs it again and it finishes.
A parent waits for its report children to finish and its ship children's PRs to merge.
A decision never starts.

The project's machine needs a checkout and a free slot.
An account needs room above zero and at or above the configured floor.
Without [dispatch rules](dispatch-rules.md), the beat chooses the account with the most room.
With routing, the rules choose an account and models for each runnable task.
A task restricted to a machine waits for a slot there.
On a machine with `pinnedOnly` set to `true`, only an explicit machine pin makes a task eligible.
A parked run's origin still limits it to its original machine, but the origin alone does not count as a pin.
New tasks start in priority order, as [Set priority](backlog-tasks.md#set-priority) describes.

## Starting and closing runs

The beat claims a task before starting it.
Its detached start command writes to `~/.orc/backlog/logs/<task-id>.log`.
Later beats read the result and close the task, park it on unanswered questions, or apply a split proposal.
See [Parked runs](parked-runs.md) and [A worker split proposal](task-kinds.md#a-worker-split-proposal).

### Closing runs

A runner task with no [pueue](https://github.com/Nukesor/pueue) record after 10 minutes closes failed.
A result that remains unreadable for 10 minutes also closes failed.
A result the beat cannot read because the command that reaches the machine exits 255, as [ssh](https://www.openssh.com) does when its connection fails, or because that read times out after 30 seconds, never closes the task.
The task's state stays unknown and the next beat reads it again, so a later read that succeeds restores the real state.
Such a beat also restarts the 10 minutes of an unreadable result.
When that command is `ssh`, orc passes it `-o ConnectTimeout=10`, so a machine that never answers usually ends as exit 255 before the read times out.
After 10 minutes without reaching the machine, the beat opens a `machine-unreached` item for you for each started task on that machine, as [The attention queue](attention-queue.md) describes.
A run still waiting for an answer stays started and the beat relays the answer.
To stop a task yourself, run `orc backlog stop <task-id>` where the backlog lives, as [Stop a task](backlog-tasks.md#stop-a-task) describes.

### Custom start command inputs

Custom start commands receive `ORC_TASK_ID`, `ORC_TASK_FILE`, `ORC_TASK_PROJECT`, `ORC_TASK_CHECKOUT`, `ORC_TASK_DELIVERY`, `ORC_TASK_MACHINE`, `ORC_TASK_PROVIDER`, `ORC_TASK_ACCOUNT`, `ORC_TASK_IMPLEMENTER_MODEL`, `ORC_TASK_FIXER_MODEL`, `ORC_TASK_ROUTED_MODELS`, `ORC_TASK_TOKEN_FILE`, `ORC_TASK_CLAUDE_CONFIG_DIR`, and `ORC_TASK_INSTRUCTIONS`.
`ORC_TASK_LOG` names the log path, and `ORC_RUN_MACHINE` names the machine.
Without routing, `ORC_TASK_IMPLEMENTER_MODEL` and `ORC_TASK_FIXER_MODEL` hold the picked account's models, or empty strings when the account names no `models`.
When routing is set, both variables are empty and `ORC_TASK_ROUTED_MODELS` holds the routed models as JSON.
The JSON requires `implementer` and can include `fixer` and `reviewer`.
Without routing, `ORC_TASK_ROUTED_MODELS` is empty.
If your custom start command forwards the task to another machine, forward all three model variables with it.
`ORC_TASK_TOKEN_FILE` holds a path, not a token.
For a token-command account, the token arrives as `orc.token.v1` on standard input.
For a `none` account, standard input is empty.
For a `claude-config` account, `ORC_TASK_CLAUDE_CONFIG_DIR` names the selected directory.

### Custom start commands and stalls

A custom start command that does not use `orc runner start` owns its task.
The beat closes it failed after its log stays quiet for 30 minutes.
To close it yourself, run `orc backlog close <task-id> <done|failed> [reason]`.
A runner task with no new output for 30 minutes reports a stall.

### Beat JSON

Run `orc beat --json` for the `orc.beat.v1` action document.
It reports starts, closures, parked questions, stalls, upstream changes, attention items, and the PRs the beat merged, is updating or did not merge, as `yolo-merged`, `yolo-updating` and `merge-refused`.

`placements` lists the tasks that reached machine selection in the beat.
Each entry names the `task` and lists its `machines` in dispatch configuration order.
Each machine has a `machine` name and a `kind` of `eligible` or `rejected`.
A rejected machine also has a `code` and a `reason` for the check that ruled it out, such as a different parked origin, an explicit or required pin, a missing checkout, no free slot, or load.
More than one machine can be eligible even though only one is chosen.
Eligibility uses the slots free when the beat considers that task, and does not mean the task started.
The `actions` list still reports what the beat did.

## Updating Orc on dispatch machines

After dispatching tasks, the beat runs [`orc update --json`](updating-orc.md) on the machine the beat runs on and through each `orc runner start -- <command>` in `dispatch.json`.
The beat names its own machine after the `dispatch.json` entry whose start runs `orc runner start` with no `--` command, and calls it `a dispatch machine` when no entry does.
The beat records the check time under `ORC_HOME` and checks again no sooner than an hour later.
Set `ORC_BEAT_UPDATE=off` on the beat process to skip the update check.

Each check adds an `update` action to `orc.beat.v1` with the machine name and the `orc.update.v1` result.
If the update command does not return a result, the action reports `unread` and names the reason.
When Orc moves to a new version, the chat posts a line such as `orc on a dispatch machine moved from 1.2.3 to 1.2.4`.
If an update fails, `orc attention` shows one `update-failed` item for that machine with the installer's error.
A failure that can be retried goes to the decider, so it stays out of your Awaiting you list, and no one decides it.
The beat retries it on the next hourly check, and the next successful check withdraws the item.
A failure that cannot be retried, such as a release that reports the wrong version, goes to you.

The beat that checked for the update and any runs already underway keep their running version.
The next scheduled beat uses the new version if its launcher reads the selected release or its path resolves to the updated [Bun](https://bun.com) installation.
Start each machine on a release that supports its install method before relying on the beat to maintain it.

<a id="merging-a-tasks-pr"></a>

## Automatic PR merges

On a project with `"yolo": true`, the beat merges, through `orc merge` with `yolo-green`, the green PR of a ship task that closed done.
The beat leaves a stopped or failed task's PR open.
A PR with a red check or a check that has not reported stays open.
While an open ship-task PR has a red check, an unreported check or no check at all, each `orc beat` prints `PR checks for <task-id>:` with the reason.
The beat also leaves a PR open when you answered `hold` to its `pr-ready` item for the current head commit.
The hold also covers Orc's pending branch update, but new work on the PR can lift it.
Releases, deletions, workflow file changes, and secret changes wait for your merge word, and the PR's `pr-ready` item in `orc attention` names the change, as [Merging a task's PR](merging-a-tasks-pr.md#choose-a-merge-basis) describes.

When the PR is behind its base and needs a branch update, `orc beat` prints a line that the update was requested.
A later beat merges the PR once the new head's checks are green, so you run nothing.
A merge the beat attempts and `orc merge` refuses shows in `orc beat` as a line naming the task and the reason.
