---
kind: reference
---
# Where orc is going
Orc grows toward the full orchestrator one step at a time.

| Capability | State |
| --- | --- |
| Chat and backlog as the front door | Ships today |
| Runs placed by free slot and account quota, across machines | Ships today |
| Code changes through checks and review into a pull request | Ships today |
| Terminal dashboard with quota, machines, queues, tasks and alerts | Ships today |
| Orchestrator rules the chat follows | Next |
| The chat posts every close, after a restart too | Next |
| Decisions held for you with a reason, answered from the chat | Ships today |
| Runs parked on a question resume on your answer | Ships today |
| Reports, investigations and machine tasks that end without a pull request | Ships today |
| Per-project delivery: direct pull request or full review | Ships today |
| Merge on your word, refusing red checks | Ships today |
| Stalled runs and machine load flagged in the chat | Ships today |
| Alerts and pull request events posted in the chat | Ships today |
| Decision boards you answer once | Ships today |
| Per-project instructions the run and the chat both read | Ships today |
| A fresh checkout before every run | Ships today |
| Follow-ups on upstream changes | Ships today |

Today a ship run counts as done once Pi stops cleanly with `ORC_COMPLETE` and the branch holds a new commit.
The checks must pass too, and no-mistakes must open a pull request with green CI.
A `direct-PR` ship run counts as done once the checks pass and its pull request opens.
A ship task that changes no code closes failed.
A scout or task run counts as done once its report exists.
A queued run from the backlog runs without the nono sandbox.
