---
kind: reference
---
# Manage backlog tasks

Use `orc backlog` to add and change tasks, hold them for answers, and read their conversations.

## Inspect the backlog

Run `orc backlog` to see new, taken, and closed tasks alongside projects and busy machine slots.
Use `orc backlog --json` for the `orc.backlog.v1` document.
Its fields are defined in `packages/run/src/widgets/beat/board.ts`.

A new task's `wait` gives its reason for waiting, or `null`.
Reasons include priority, an unanswered question, a dependency, or a child.
Its `waiting` field also reports machine or account room from the last beat.
Each beat replaces `~/.orc/backlog/waits.json` with the reasons it gave those tasks.
A `room` wait carries the last beat's reason as `detail` and that beat's time as `at`, or `null` for both when the last beat gave the task no reason.

## Add and change tasks

Run `orc backlog add <project> <task-file>` to add a task.
To read the task from a pipe, use `-` instead of a file, for example `printf '# Fix the login page\n' | orc backlog add orc -`.
Orc reads standard input to its end and refuses a terminal.

Use `--machine <name>` to restrict the task to one machine.
Add `--depends-on <task-id>` for each prerequisite.
Use `--kind scout` or `--kind task` for a report instead of a PR.
For a parent task or automatic splitting, see [Task kinds](task-kinds.md).
Use `--internal` for a ship task that is internal-only in a `no-mistakes-prod-only` project.

Orc assigns a unique `<project>-<n>` ID.

### Set priority

The beat considers new tasks in priority order, from 0 first to 4 last.
For equal priority, the oldest `created` time comes first, followed by the lower ID when times match.

Add `--priority <0-4>` when adding a task, or run `orc backlog priority <task-id> <0-4>` later.
Use `orc backlog priority <task-id> none` to clear it and prevent the task from starting.
Orc refuses changes to taken, started, or closed tasks and leaves holds and questions on held or parked tasks unchanged.

The task file stores `priority`, and a missing key means no priority.
A split preserves it on the parent and children, as [Splitting at intake](task-kinds.md#splitting-at-intake) and [A worker split proposal](task-kinds.md#a-worker-split-proposal) describe.
The text backlog shows `P<n>` beside the ID, and JSON reports a number from 0 to 4 or `null`.

### Dependencies

Run `orc backlog depend <task-id> --on <task-id>,<task-id>` to replace a new or held task's dependencies.
Use `--clear` instead to remove them.
Changing dependencies does not change a hold.
Orc refuses unknown, taken, started, closed, or parked tasks, self-dependencies, and dependency cycles.

### Edit a task

Run `orc backlog edit <task-id> <task-file>` to replace a new task's title and body.
Use `-` to read from a pipe, as with `add`.
The edit preserves task metadata and works on held, parked, and parent tasks.
Orc refuses text without a title and tasks that have already been taken.

### Drop a task

Run `orc backlog drop <task-id> <reason>` to withdraw a new task, including a held or parked task.
Orc records the reason, withdraws attention items, and posts the close in chat.
Use `orc backlog stop` for a taken or started task and `orc backlog plan <parent> --drop <child>` for a child.
A parent with an open child or a task another open task depends on cannot be dropped.

### Close a parked task whose work merged elsewhere

Run `orc backlog close <task-id> --landed-in <pr-url>` with the full URL of the merged PR.
Orc records that URL in the close reason and marks the parked task done.
Tasks that depend on it no longer wait for it.
Orc withdraws the task's open attention items and leaves the parked run's branch and PR untouched.
The command records your decision without checking the PR on the forge.

### Retry a task

Run `orc backlog retry <task-id>` to run a failed or stopped task again.
When it has kept work, the beat resumes it on the original machine and branch.
Otherwise, the beat places it normally.

### Send a task back

Run `orc backlog send-back <task-id> <words>` to request another pass on a closed task's open PR.
For example, run `orc backlog send-back orc-9 rename the flag`.
You can also select **Send back** beside a PR awaiting approval in the Agents tab.

Orc moves the task to `new` and parks it on `orc/<task-id>`.
It records your words as the answer to `send-back` and saves the closing machine, run, and PR in `parked_origin`.
It sets `parked_at` and `parked_sent_back_at` to the send-back time.
The next beat resumes the implementer's session on the same machine and branch with your review.
Checks run again and the push updates the same PR.
The PR remains recorded even if the resumed run closes before pushing.

Before the next beat starts the task, repeat `send-back` to add more words in order.
Orc refuses a task that is neither closed nor sent back, has no PR, has a closed or merged PR, or has no run left on the runner.

For a parked task whose machine and run were not recorded, use `orc backlog origin <task-id> <machine> <run-id>`.
See [Parked runs](parked-runs.md).

## Stop a task

To stop a task yourself, run `orc backlog stop <task-id>` where the backlog lives.
It kills the run through the machine that started it and closes the task stopped.
A stop for a task on a machine whose start runs any other program refuses, so close that task by hand with `orc backlog close <task-id> failed`.

### PR state

The closed task file keeps the PR link of the orc run on `orc/<task-id>` as `pr`, and `orc backlog --json` carries it as `pr`, or `null` when the run opened none.
Every task in `orc backlog --json` carries `prState` as `open`, `closed`, `merged`, or `null`.
`prState` is `null` when the task has no PR, or when the beat has not read its PR yet.
A recorded `<task-id>.merged` event makes it `merged`, and a recorded `<task-id>.pr-closed` event makes it `closed`.
Without either event it is the last state the beat read for the PR.
`orc backlog --json` reads those records without contacting the forge.
For a task closed with `--landed-in`, `landedIn` names the merged PR instead of `pr`.

The beat prints `closed <task-id> <done|failed|stopped> on <machine>` with the reason and the PR when the run opened one, or `close failed <task-id> on <machine>` with the reason when the read fails or runs past 30 seconds, until it stays unread for 10 minutes.

## Hold a task for an answer

Run `orc backlog hold <task-id> --reason <text> [--until <YYYY-MM-DD>]` to pause a new task for your decision.
The beat reports `waits <task-id>: held for the captain: <reason>`, with the date if set, and creates an [attention item](attention-queue.md).
The date is a reminder, not an automatic release.

Run `orc backlog answer <task-id> <words>` to release the hold.
Orc records the answer and `answered_at`, and a later beat may start the task.
The run receives the task body followed by hold reasons and answers in chronological order.
A hold the beat places on a [resume that parks again](parked-runs.md#a-resume-that-parks-again) is the exception.
Its releases travel with the resume as guidance instead of in the body.
Orc refuses holds on taken, started, closed, or parked tasks, and answers when no question is open.
Holding a held task again keeps its first reason.

To ask several questions, add `--question <text>` for each.
Orc names them `question-1` onward.
Answer each with `orc backlog answer <task-id> <question-id>=<words>`.
The hold stays open until all questions are answered, and the final answer writes all questions and answers into `answer` for the run.
Repeating the same questions keeps the hold, but different questions are refused until the open ones are answered.

You can hold the task again after answering and before it starts.
Earlier holds remain in the task's `hold_history`, where each entry names its time as `at`.

## Task notes

To leave a note on a task, run `orc backlog note <task-id> <words>`.
Notes work on open and closed tasks.
A note does not hold a task or answer a question.

## Task thread

Run `orc backlog thread <task-id>` to read a task's questions, answers, decisions, and notes in time order.
Add `--json` for an `orc.thread.v1` document.
A decision entry for an escalated question carries the decider's recommended option as `recommendation`.
Its fields are defined in `packages/run/src/features/task-thread/thread.ts`.
The thread includes closed tasks.
Orc refuses an unknown task ID.
