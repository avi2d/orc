---
kind: reference
---
# Task kinds
A task file's `kind` is `ship`, `scout` or `task`, and a file with no `kind` reads as `ship`.
Orc refuses any other kind, from `orc backlog add --kind` or in a task file, with `the kind <word> is not ship, scout or task`.
`orc backlog` names a scout or task beside its id, as in `orc-1 scout orc`, and `orc backlog --json` gives every task a `kind`.

A `ship` task runs as [Running a task](running-a-task.md) shows and ends in a PR.
A `scout` reads the checkout and changes nothing, and a `task` does what it asks and puts its evidence in the report.
The runner queues either as `orc run <task-file> --kind <scout|task> --sandbox none`.
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
