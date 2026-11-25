---
kind: reference
---
# Merge a PR and turn on yolo
To land a closed task's PR, run `orc merge <task-id>`, or tell the chat to merge it.
Orc squash-merges the PR only when it is open and every check is green.
Otherwise it merges nothing and says why.
When the branch is behind its base and neither side changed a file the other did, orc merges it without updating.
When they share a changed file, `orc merge` updates the branch from the base, waits for the new checks, and merges once they are green.
Orc updates it the same way when GitHub refuses the branch as out of date.
Each beat raises an alarm when a push run on the default branch fails.
The chat passes `--no-wait` and returns after requesting the update without waiting for CI or merging.
Once the new head checks are green, ask the chat to merge again.
The next merge call refuses a new head that leaves out the checked head, a red check, and a check that was green before the update but has not reported green since.
When a check from before the update never reports again, run `orc merge <task-id> --basis <basis>` yourself, which waits for the new head's own checks and merges once they are green.
When the update conflicts, or a check turns red while the command waits, orc merges nothing and sends the task back for a fix.

## Turn on yolo
The chat merges on your word.
To let the beat merge a yolo project's green PR on its own, and to let the chat merge it when you ask, add `"yolo": true` to that project in `projects.json`.
The beat merges only a task that closed done, and a release, a deletion, a workflow file change or a secret change still waits for your word.
Orc refuses a `yolo` that is not `true` or `false`, and a project with no `yolo` waits for your word.
[Merging a task's PR](run/merging-a-tasks-pr.md) names every refusal.
