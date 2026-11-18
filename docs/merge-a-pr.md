---
kind: reference
---
# Merge a PR and turn on yolo
To land a closed task's PR, run `orc merge <task-id>`, or tell the chat to merge it.
Orc squash-merges the PR only when it is open, every check is green and the branch is not behind its base.
Otherwise it merges nothing and says why.

The chat merges on your word.
To let orc merge a project's green PRs by itself, add `"yolo": true` to that project in `projects.json`.
The beat then merges a closed done task's PR once every check is green, and the chat merges one when you ask.
A task that closed stopped or failed never auto-merges, even when its checks later turn green.
A release, a deletion, a workflow file change or a secret change still waits for your word and shows in `orc attention`.
Orc refuses a `yolo` that is not `true` or `false`, and a project with no `yolo` waits for your word.
[Merging a task's PR](run/merging-a-tasks-pr.md) names every refusal.
