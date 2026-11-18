---
kind: reference
---
# Run review and results

The review and result are described in [Running a task](running-a-task.md).

## Review and questions

See [Answer a review question](running-a-task.md#answer-a-review-question).

## Run result

See [Results](running-a-task.md#results).

## Run files

See [Watch the run](running-a-task.md#watch-the-run).
At 300 turns or 5 compactions, an implementation session records a `long-session` warning and writes `handover.md` in the run folder.
The handover names the commits made and why the run stopped, so a later run on the branch can continue from it.
