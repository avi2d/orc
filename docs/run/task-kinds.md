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
The runner queues it as `orc run <task-file> --branch orc/<task-id>-parent --kind parent --sandbox none`, which reviews no code and changes nothing in the checkout.
It starts fresh there and never resumes the worker's failed run, whose partial work stays on `orc/<task-id>`.
Pi runs the whole result in the real place it serves, checks each done criterion, and ends `agent-report.md` with the line `verdict: pass` or `verdict: fail`.
A report whose last line is `verdict: pass` closes the parent done with its report.
Any other report records the run failed with `the final check did not end its report at <path> with verdict: pass`, and the beat closes the parent failed with that reason and keeps the report path.

### Splitting at intake

When `models.planner` in `config.json` names a model, as [Configuring providers](configuring-providers.md) shows, `orc backlog add` asks it to plan each ship task added without `--parent` before the task lands.
The budget for one task is about 300 changed lines or one area.
A request within the budget lands as one task, and orc prints `planned as one task: <reason>` under the added line.
A request over the budget lands as a parent with the planner's done criteria under `## Done when`, and one ship child for each vertical slice, each one PR that merges on its own.
A child waits until each earlier child the plan names has merged, so the next beat starts every child that waits on nothing at the same time.
Each child also waits on what the added request waited on.
The parent's task file keeps `split: {"by": "intake", "reason": <text>}`, which `orc backlog --json` gives every task as `split`, and orc records the event `<parent-id>.split` that orc chat posts.
A planner that fails, runs past five minutes or prints no `orc.split.v1` document leaves the request as one task, and orc prints `not planned, so it runs as one task: <why>`.
With no `models.planner`, orc asks no model and adds the task as it is.

The planner prints one JSON document:

```json
{
  "schema": "orc.split.v1",
  "plan": "split",
  "reason": "it touches the record, the intake and the listing",
  "done": ["a big request lands as a parent with children"],
  "children": [
    { "title": "Record the split", "body": "Add the split mark to the task record.", "after": [] },
    { "title": "Plan at intake", "body": "Split an over-budget request when it is added.", "after": [1] }
  ]
}
```

A request within the budget prints `{"schema": "orc.split.v1", "plan": "whole", "reason": <text>}`.
`after` numbers earlier children from 1, and orc refuses a plan with fewer than two children or a child that waits on a later one.

### A worker split proposal

A ship worker that finds the change over the budget can stop and propose a split using the same `orc.split.v1` document.
Orc records the run as failed without running checks or opening a PR.
`orc runner result <task-id> --json` returns the validated document as `result.run.split`, and the text result prints it in the run reason.
The beat turns the task into a parent instead of closing it, with the proposal's done criteria under `## Done when` and `split: {"by": "run", "reason": <text>}`.
It adds one ship child for each slice, linked and waiting as [Splitting at intake](#splitting-at-intake) adds them, and starts every child that waits on nothing in the same beat.
When the task that proposes the split already has a parent, the slices join that parent as children instead, since orc refuses a parent given a parent.
The proposal's done criteria join that parent under `## Done when` as lines naming the split task, so the final check verifies them with the rest.
The task then leaves that parent and closes done with the reason `split into <child-ids>: <reason>`, and every task that waited on it waits on all of the slices instead.
The beat prints `split <task-id> on <machine> into <child-ids>: <reason>` and records the event `<task-id>.split` that orc chat posts, as in `orc-1 Ship task splitting split at run into orc-2 Record the split, orc-3 Show the plan: <reason>`.
A run whose proposal orc refused ends as `invalid split proposal: <why>`, and the beat closes that task failed with no children.

### Changing a plan

To see a parent's plan, run `orc backlog plan <task-id>`, which prints its count line, how it was split, and one line per child with its state and what it still waits on:

```text
orc-1 parent orc 0 of 3 done Ship task splitting
split at intake: it touches the record, the intake and the listing
orc-2 started on mac Record the split
orc-3 new Show the plan
orc-4 new waits orc-2,orc-3 Plan at intake
```

To drop a child from the plan, run `orc backlog plan <task-id> --drop <child-id>`, which removes its task file and lowers the parent's count.
Orc refuses a child that is taken, started, closed or parked, and one another open task waits on until `orc backlog depend` changes that wait.
To add a slice, run `orc backlog add <project> <task-file> --parent <task-id>`, and to reorder slices, run `orc backlog depend`.
