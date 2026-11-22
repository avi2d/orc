---
kind: reference
---
# The runner

Run `orc runner start` to queue a task from the beat in [pueue](https://github.com/Nukesor/pueue).
The run survives the beat and a dropped [SSH](https://www.openssh.com) connection.

## Queue a task

The runner reads the beat's `ORC_TASK_*` variables and queues `orc run` in the `orc` pueue group.
It uses `orc/<task-id>`, or `orc/<task-id>-parent` for a parent.
The run uses `--sandbox none` and the selected provider.
A token account also supplies `--token-file`.

### Select models and thinking levels

`ORC_TASK_IMPLEMENTER_MODEL` and `ORC_TASK_FIXER_MODEL` select the run's models.
A model in an agent file takes precedence.
Without the variables, the run uses its config or agent files.

`ORC_TASK_IMPLEMENTER_THINKING` and `ORC_TASK_FIXER_THINKING` select the run's thinking levels.
The runner passes them to `orc run` as `--implementer-thinking` and `--fixer-thinking`.
A handed level takes precedence over the `thinking` line of the agent file.
The level is one of `off`, `minimal`, `low`, `medium`, `high` or `xhigh`.
The runner refuses any other level before it queues the run.
The run history records the handed level on the step row.
Without the variables, the run uses the agent file's `thinking` line.

The beat sets none of these four variables yet.
They stay unset until the routes task lands.

### Queue limits and files

The runner updates the checkout's default branch and needs [Git](https://git-scm.com) 2.48 or later.
It sets the pueue group's limit from the machine's slots.
Zero slots becomes one because pueue treats zero as unlimited.
A task already queued or running for this home is not queued again.
A completed task can be queued again.

### Alert stream

When `orc-dash` is on `PATH`, the runner queues `orc-dash alerts --json` and appends its output to `~/.orc/backlog/alerts.jsonl`.
A running stream is not duplicated.
If pueue refuses the stream, the runner reports the error and still queues the task.

## Queue on another machine

Run `orc runner start -- ssh linux-box orc` to queue on another machine.
The remote command must have the run's tools on its `PATH`.
Unsandboxed agents and checks retain the remote `XDG_RUNTIME_DIR` when set, so pueue clients can reach the user service.

## Token storage and renewal

The runner stores a supplied token under `~/.orc/runner/tokens/<task-id>/token`, readable only by its owner.
The run waits for a live token before starting and can restart a run after token expiry.
A guard removes the token folder after the queued task ends.
If pueue is unreachable, it keeps the folder so the run can use the token after a daemon restart.

`orc runner renew` reads a task and fresh token as JSON on standard input.
Add `--` and the remote orc command to renew on another machine.
A renewal for a task that is no longer running is refused and removes its token folder.

## Stop a run

Run `orc runner kill <task-id>` on the task's machine.
It removes the task from pueue or stops it and marks its orc runs stopped.
The next beat closes the task stopped.
Orc refuses a task that was never queued or is already done.

## Read a result

Run `orc runner result <task-id>` on the task's machine, or add `-- ssh linux-box orc` for another machine.
Add `--json` for an `orc.runner.v1` document.
The beat, runner, and run must use the same orc version.

The result reports the pueue state and latest run, including its PR.
Use `--label <label>` to read another home's run.
A parent defaults to its final check.

## Answer a waiting run

Pipe JSON to `orc runner answer <task-id>` on its machine:

```json
{"label":"<label>","asking":"<asked>","answers":[{"question":"<id>","answer":"<text>"}]}
```

The label is optional.
Get `asking` from `orc runner result --json`.
Orc refuses a run that is not waiting or whose asking time differs.

## Read machine load

Run `orc runner load` to print the five-minute load the beat compares with the machine's limit.
It also reports the heavy queue unless `through` is set.

## Queue heavy calls

The runner sets up the heavy queue unless `through` is set.
See [The heavy queue](heavy-queue.md) for tools, bypasses, checks, and settings.
