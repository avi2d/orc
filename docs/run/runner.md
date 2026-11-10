---
kind: reference
---
# The runner
`orc runner start` is the start command that hands a task to pueue on its machine.
The run then outlives the beat, the dispatcher and any SSH link to it.
It reads the task from the beat's `ORC_TASK_*` variables and queues `orc run` in the checkout on branch `orc/<task-id>`, in the pueue group `orc`.
The run takes `--sandbox none --provider <provider> --token-file <path>` when the account holds a token file or token, and `--sandbox none --provider <provider>` with no token file when the account is kind `none`, so it runs on the picked account and refuses an implementer on any other provider.
When the run starts, it fast-forwards the checkout's default branch from its remote, or says in its output why not.
The refresh needs Git 2.48 or later.
The group's parallel limit caps the orc runs on that machine, and they never wait behind other groups.
The runner creates the `orc` group when the machine lacks it.
The task file goes to `~/.orc/runner/<task-id>.md` on that machine, and the run reads it from there.
When the task names instructions, the queued `orc run` gets `--instructions` pointing at a copy in `~/.orc/runner/<task-id>.instructions/<file name>` on that machine.
A task queued for another home keeps a scoped file instead, so two homes holding the same task id never share one file.
A task this home already holds queued or running in group `orc` is not queued again, and a task whose earlier run is done there is queued again, as a parked task is once answered.

When `orc-dash` is on its PATH, `orc runner start` also queues `orc-dash alerts --json` in pueue on the machine it runs on, with its output appended to `~/.orc/backlog/alerts.jsonl`.
It queues that stream once, in a group of its own home that runs one task at a time, so a stream already queued or running is not queued again, and one that ended is queued again at the next start.
When pueue refuses the stream, the start prints why on standard error and still queues the task.

To start on another machine, put the command that runs orc there after `--`, as in `orc runner start -- ssh linux-box orc`.
That runs `orc runner queue` on the far side and sends it the task as JSON on stdin, so the task text never passes through a remote shell.
SSH can drop once pueue holds the run, since pueue on that machine owns it.
Pueue runs the task with the environment of the command that queued it.
So the command after `--` must give orc the `PATH` its runs need on that machine.
The queue records the resolved absolute `ORC_HOME` with the task.

A task that comes with a token instead of a token file keeps it in `~/.orc/runner/tokens/<task-id>/token`, readable only by its owner, beside the expiry in `expires-at`.
A task queued for another home keeps its token under a scoped folder instead, so two homes holding the same task id never share one token.
Pueue then runs `orc runner hold <task-id> -- orc run ... --token-file <that file>`, and the hold runs the run.
The hold starts the run only while the token is live, and otherwise waits for a fresh one.
Pi reads the token once per process.
So a run that fails after its token ran out starts again on the fresh token instead of failing the task.
The queue starts a detached guard that waits for the pueue task to finish and then removes the token folder.
The guard covers the whole queued life of the task.
It removes the folder when the run succeeds, fails, is killed, or never starts.
It leaves the folder when pueue itself is unreachable, so the run still has its token after a daemon restart.
A `pueue kill` gives the hold no time to clean up, so the guard removes the folder after pueue reports the task done.

`orc runner renew` reads a task and its fresh token as JSON on standard input and replaces the token the task holds.
Add `--` and the command that runs orc on another machine to send it there, as with `orc runner start`.
A renewal for a task pueue no longer runs for that home is refused and removes that task's token folder.

To stop a run yourself, run `orc runner kill <task-id>` on its machine.
It kills the running pueue task that carries the label, or removes one still queued, and marks the orc run on `orc/<task-id>` stopped.
Removing a queued task records a stopped run when no run of the branch is still running, since the run never started.
The next beat then closes the task stopped with the run's end reason.
A kill for a task pueue never queued is refused, as a kill for a task already done is.

To read how a task's run went, run `orc runner result <task-id>` on its machine, or `orc runner result <task-id> -- ssh linux-box orc` from another.
The forwarded read defaults to that home's label, and `orc runner result <task-id> --label <label>` reads another home's run instead.
The forwarded read carries the label as JSON on standard input, past any remote shell the reach uses, and marks the far command with `--stdin-label` so only a marked read waits on standard input.
A plain `orc runner result <task-id>` never reads standard input, so a pipe that never closes cannot hang it.
Piping that document into `orc runner result <task-id> --stdin-label` yourself reads that home's run.
It names pueue's state for the task and the orc run on `orc/<task-id>` with its PR.
A task is queued, stashed, running, paused, succeeded or failed, or unknown when no pueue task in group `orc` carries that home's label.
An unknown task with a stopped run still names that run with its end reason.
To print the same facts as JSON, add `--json`, whose document names its version first as `orc.runner.v1`.
The beat and the runner and the run on one task must share one orc version.
To hand answers to a run waiting at its no-mistakes gate, pipe a JSON document into `orc runner answer <task-id>` on its machine.
The document reads `{"label": "<label>", "asking": "<asked>", "answers": [{"question": "<id>", "answer": "<text>"}]}`, where the label is optional.
Its `asking` is the time the run asked, as `orc runner result --json` shows it.
It writes them into that run's `answers.json`.
It refuses a task whose run waits for no answer, or waits on an asking other than the one named.
To print the five minute load average the beat compares against a load limit, run `orc runner load` on that machine.

## Queue heavy calls
`orc runner start` writes stand in scripts for heavy tools and arms the watchdog beside the alert stream.
`orc run` puts the stand in folder first on `PATH` for the agent it starts.
[The heavy queue](heavy-queue.md) names the queued tools, the bypass, the check command and the tuning keys.
