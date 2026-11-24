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
A parent waits for its report children to finish and its ship children's PRs to merge.
A decision never starts.

The project's machine needs a checkout and a free slot.
An account needs room above zero and at or above the configured floor.
The beat chooses the account with the most room.
A task restricted to a machine waits for a slot there.
New tasks start in priority order, as [Set priority](backlog-tasks.md#set-priority) describes.

## Starting and closing runs

The beat claims a task before starting it.
Its detached start command writes to `~/.orc/backlog/logs/<task-id>.log`.
Later beats read the result and close the task, park it on unanswered questions, or apply a split proposal.
See [Parked runs](parked-runs.md) and [A worker split proposal](task-kinds.md#a-worker-split-proposal).

A runner task with no pueue record after 10 minutes closes failed.
A result that remains unreadable for 10 minutes also closes failed.
A run still waiting for an answer stays started and the beat relays the answer.
To stop a task yourself, run `orc backlog stop <task-id>` where the backlog lives, as [Stop a task](backlog-tasks.md#stop-a-task) describes.

Custom start commands receive `ORC_TASK_ID`, `ORC_TASK_FILE`, `ORC_TASK_PROJECT`, `ORC_TASK_CHECKOUT`, `ORC_TASK_DELIVERY`, `ORC_TASK_MACHINE`, `ORC_TASK_PROVIDER`, `ORC_TASK_ACCOUNT`, `ORC_TASK_IMPLEMENTER_MODEL`, `ORC_TASK_FIXER_MODEL`, `ORC_TASK_TOKEN_FILE`, `ORC_TASK_CLAUDE_CONFIG_DIR`, and `ORC_TASK_INSTRUCTIONS`.
`ORC_TASK_LOG` names the log path, and `ORC_RUN_MACHINE` names the machine.
`ORC_TASK_IMPLEMENTER_MODEL` and `ORC_TASK_FIXER_MODEL` hold the picked account's models, or empty strings when the account names no `models`.
If your custom start command forwards the task to another machine, forward both model variables with it.
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

## Merging a task's PR

On a project with `"yolo": true`, the beat merges, through `orc merge` with `yolo-green`, the green PR of a ship task that closed done.
The beat leaves a stopped or failed task's PR open.
A PR with a red check or a check that has not reported stays open.
The beat also leaves a PR open when you answered `hold` to its `pr-ready` item for the current head commit.
The hold also covers Orc's pending branch update, but new work on the PR can lift it.
Releases, deletions, workflow file changes, and secret changes wait for your merge word, and the PR's `pr-ready` item in `orc attention` names the change, as [Merging a task's PR](merging-a-tasks-pr.md#choose-a-merge-basis) describes.

When the PR is behind its base and needs a branch update, `orc beat` prints a line that the update was requested.
A later beat merges the PR once the new head's checks are green, so you run nothing.
A merge the beat attempts and `orc merge` refuses shows in `orc beat` as a line naming the task and the reason.
