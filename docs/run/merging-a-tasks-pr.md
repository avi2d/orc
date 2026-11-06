---
kind: reference
---
# Merging a task's PR
To land a closed task's PR, run `orc merge <task-id>`.
Orc reads the PR with `gh pr view` and merges nothing when any of these holds:

- The task names no PR.
- The PR is closed or merged, not open.
- A check is red, a check has not reported, or no check has reported at all.
  Only the newest attempt of each run and check counts, so a cancelled run that re-ran green reads green.
- The branch is behind its base by the compare API's `behind_by`, so update the branch and let its checks run again.

Each refusal starts `orc merge refused <task-id> and merged nothing` and names every reason.
Otherwise orc runs `gh pr merge <url> --squash --match-head-commit <sha>` at the head it checked, so a push after the check merges nothing.

A project in `projects.json` may add `"yolo": true`, and a project with no `yolo` reads as `false`.
Orc refuses any `yolo` other than `true` or `false` with `the project <name> names yolo <value>, which is not true or false`.
`orc merge` takes `--basis captain-word`, the default, or `--basis yolo-green`.
The chat merges with `captain-word` only when you said to merge that PR.
It merges with `yolo-green` when you ask it to merge a yolo project's PR and the PR is green.
Orc refuses `yolo-green` for a project without `yolo` true.
Either basis meets every refusal above.
