---
kind: reference
---
# Merge a PR and turn on yolo
To land a closed task's PR, run `orc merge <task-id>`, or tell the chat to merge it.
Orc squash-merges the PR only when it is open and every check is green.
Otherwise it merges nothing and says why.
When the branch is behind its base, `orc merge` updates it from the base, waits for the new checks, and merges once they are green.
The chat passes `--no-wait` and returns after requesting the update without waiting for CI or merging.
Once the new head checks are green, ask the chat to merge again.
The next merge call refuses a new head that leaves out the checked head, a red check, and a check that was green before the update but has not reported green since.
When a check from before the update never reports again, run `orc merge <task-id> --basis <basis>` yourself, which waits for the new head's own checks and merges once they are green.
When the update conflicts, or a check turns red while the command waits, orc merges nothing and sends the task back for a fix.

The chat merges on your word.
To let it merge a yolo project's PR when you ask and the PR is green, add `"yolo": true` to that project in `projects.json`.
Orc refuses a `yolo` that is not `true` or `false`, and a project with no `yolo` waits for your word.
[Merging a task's PR](run/merging-a-tasks-pr.md) names every refusal.
