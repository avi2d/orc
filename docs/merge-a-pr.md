---
kind: reference
---
# Merge a PR and turn on yolo
To land a closed task's PR, run `orc merge <task-id>`, or tell the chat to merge it.
Orc squash-merges the PR only when it is open and every check is green.
Otherwise it merges nothing and says why.
When the branch is behind its base and neither side changed a file the other did, orc merges it without updating.
When they share a changed file, orc updates the branch from the base, waits for the checks on the new head and merges once they are green.
Orc updates it the same way when GitHub refuses the branch as out of date.
Each beat raises an alarm when a push run on the default branch fails.
When the update conflicts or a check on the new head turns red, orc merges nothing and sends the task back for a fix.

The chat merges on your word.
To let it merge a yolo project's PR when you ask and the PR is green, add `"yolo": true` to that project in `projects.json`.
Orc refuses a `yolo` that is not `true` or `false`, and a project with no `yolo` waits for your word.
[Merging a task's PR](run/merging-a-tasks-pr.md) names every refusal.
