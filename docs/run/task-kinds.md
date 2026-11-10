---
kind: reference
---
# Task kinds
A task file's `kind` is `ship`, `scout`, `task` or `parent`, and a file with no `kind` reads as `ship`.
Orc refuses any other kind, from `orc backlog add --kind` or in a task file, with `the kind <word> is not ship, scout, task or parent`.
`orc backlog` names a scout, task or parent beside its id, as in `orc-1 scout orc`, and `orc backlog --json` gives every task a `kind`.

A `ship` task runs as [Running a task](running-a-task.md) shows and ends in a PR.
A `scout` reads the checkout and changes nothing, and a `task` does what it asks and puts its evidence in the report.
The runner queues a scout or task as `orc run <task-file> --kind <scout|task> --sandbox none`.
To run one directly, enter a clean checkout of the target project and run the same command.
That run skips no-mistakes and the PR and creates no branch.
It starts Pi on the host in `~/.orc/runs/<run-id>`, tells it where the task and the checkout are, and asks it to write `agent-report.md` there.
Orc refuses a scout or task run without `--sandbox none`, and refuses `--allow` and `--answer` on one.
It prints `orc: <kind> run <run-id> wrote its report to <path>` and records the run succeeded, or prints why it wrote none, records the run failed and exits non-zero.
The beat closes the task done with the reason `the run wrote its report` and keeps the path as `report` in the task file and in `orc backlog --json`.
When no report exists, it closes the task failed with `the run wrote no report` and the run's reason, even when pueue says the run succeeded.
The beat prints the report path in its `closed` line.
The chat posts it where a shipped task posts its PR, as in `orc-1 Map the parser closed done: the run wrote its report, report /home/me/.orc/runs/<run-id>/agent-report.md`.
A scout or task marked for a machine waits for room there as any task does.

## Parent tasks

A `parent` holds the captain's words and the done criteria for work too large for one PR, and has no code or PR of its own.
Add it with `orc backlog add <project> <task-file> --kind parent`, then add each part with `orc backlog add <project> <task-file> --parent <task-id>`.
The child's task file keeps the link as `parent`, and `orc backlog --json` gives every task a `parent` and every parent `children` as `{"done": <n>, "total": <n>}`.
Children may wait on each other with `--depends-on`, and the beat starts the children that wait on nothing at the same time.
Orc refuses a `--parent` the backlog does not hold, one that is not a parent, or one that is no longer new.
Orc refuses a parent given a parent and a child that waits on a task already waiting on its parent.
Until every scout and task child closes done and every ship child with a PR merges, each beat prints `waits <task-id>: waits on its children, <done> of <total> done`, or `waits for its first child` while it has none.
A failed child keeps its parent waiting.
`orc backlog` shows the count on the parent's line, as in `orc-1 parent orc 3 of 5 done Ship the whole feature`.

When every scout and task child closed done and every ship child with a PR merged, the beat starts the parent's final check once.
The runner queues it as `orc run <task-file> --kind parent --sandbox none`, which reviews no code and changes nothing in the checkout.
Pi runs the whole result in the real place it serves, checks each done criterion, and ends `agent-report.md` with the line `verdict: pass` or `verdict: fail`.
A report whose last line is `verdict: pass` closes the parent done with its report.
Any other report records the run failed with `the final check did not end its report at <path> with verdict: pass`, and the beat closes the parent failed with that reason and keeps the report path.
