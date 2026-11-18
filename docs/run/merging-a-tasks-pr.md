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

Each refusal starts `orc merge refused <task-id> and merged nothing` and names every reason.
Otherwise orc runs `gh pr merge <url> --squash --match-head-commit <sha>` at the head it checked, so a push after the check merges nothing.

## A PR behind its base
When the compare API's `behind_by` says an open green PR is behind its base, orc updates the branch instead of refusing it.
It prints `Updating from main` and runs `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch -f expected_head_sha=<sha>` with the head it checked.
It then prints `Checks running` and reads the PR again with `gh pr view`, first after 1 second and then at doubling waits of at most 15 seconds.
It waits until the head has moved, every check on the new head has reported and every check that was green on the checked head is green on the new head, for at most 20 minutes.
A read that fails during the wait counts as no answer, and orc keeps waiting until the 20 minutes end.
It stops waiting early once a check on the new head is red.
It reads the new head's parents and treats a head that leaves out the checked head as changed after the approval.
Once the new head is green and no longer behind, orc runs `gh pr merge <url> --squash --match-head-commit <new sha>`.

## When an update fails

Orc merges nothing and refuses when any of these holds:

- update-branch reports a merge conflict.
- A check on the new head is red.
- update-branch answers HTTP 422 because the head is no longer the one orc checked, so someone changed the PR after the approval.
- The new head leaves the checked head out of its parents, so someone changed the branch after the approval.
- The checks on the new head do not all report within 20 minutes.
- Orc still cannot read the PR when the 20 minutes end, so it cannot tell what the new head holds.
- The new head is still behind its base, because the base moved again.

After a merge conflict or a red check on the new head, orc also sends the task back as [`orc backlog send-back`](backlog-and-beat.md) does, with words that name the conflict or the red check.
The next beat resumes the task's run on its branch for a fix pass.

## Choose a merge basis

A project in `projects.json` may add `"yolo": true`, and a project with no `yolo` reads as `false`.
Orc refuses any `yolo` other than `true` or `false` with `the project <name> names yolo <value>, which is not true or false`.
`orc merge` takes `--basis captain-word`, the default, or `--basis yolo-green`.
The chat merges with `captain-word` only when you said to merge that PR.
It merges with `yolo-green` when you ask it to merge a yolo project's PR and the PR is green.
Orc refuses `yolo-green` for a project without `yolo` true.
Either basis meets every refusal above.
