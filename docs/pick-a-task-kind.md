---
kind: reference
---
# Pick a task kind
Each task has a kind, and the kind decides how its run ends:

- `ship`, the default, changes code and ends in a pull request through the checks and the delivery [Pick a delivery mode](pick-a-delivery-mode.md) names.
- `scout` reads the checkout, changes nothing and ends in a report.
- `task` does the work it describes and ends in a report with its evidence.

To pick one, add `--kind scout` or `--kind task` to `orc backlog add` or `orc run`, or say it in the chat.
A scout or task run skips no-mistakes and the pull request.
Pi works in the run folder and writes `agent-report.md` there.
The task closes done with the report's path, or closes failed when no report exists.
To keep a task on one machine, add `--machine <name>`, and it waits for room there instead of starting elsewhere.
