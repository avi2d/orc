---
kind: reference
---
# Merge a PR and turn on yolo
To land a closed task's PR, run `orc merge <task-id>`, or tell the chat to merge it.
Orc squash-merges the PR only when it is open, every check is green and the branch is not behind its base.
Otherwise it merges nothing and says why.

The chat merges on your word.
To let it merge a yolo project's PR when you ask and the PR is green, add `"yolo": true` to that project in `projects.json`.
Orc refuses a `yolo` that is not `true` or `false`, and a project with no `yolo` waits for your word.
[Merging a task's PR](run/merging-a-tasks-pr.md) names every refusal.
