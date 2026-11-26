---
kind: reference
---
# Pick a task kind
Each task has a kind, and the kind decides how it ends:

- `ship`, the default, changes code and ends in a pull request through the checks and the delivery [Pick a delivery mode](pick-a-delivery-mode.md) names.
- `scout` reads the checkout, changes nothing and ends in a report.
- `task` does the work it describes and ends in a report with its evidence.
- `parent` holds the done criteria for work too large for one PR and waits for its children.
- `decision` asks you a question and never runs, as [Decisions](run/task-kinds.md#decisions) shows.

To pick one, add `--kind scout`, `--kind task`, `--kind parent` or `--kind decision` to `orc backlog add`, or say it in the chat.
Add `--kind scout`, `--kind task` or `--kind parent` to `orc run`.
A decision never runs, so `orc run --kind decision` is refused.
To split a large task, add a parent and its children, as [Parent tasks](run/task-kinds.md#parent-tasks) shows.
To split an over budget request at intake, name a planner model, as [Splitting at intake](run/task-kinds.md#splitting-at-intake) shows.
A scout or task run skips [no-mistakes](https://github.com/kunchenguid/no-mistakes) and the pull request.
[Pi](https://pi.dev) works in the run folder and writes `agent-report.md` there.
A scout or task closes done with the report's path, or closes failed when no report exists.
To keep a task on one machine, add `--machine <name>`, and it waits for room there instead of starting elsewhere.
