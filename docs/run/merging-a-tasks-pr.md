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
When an open green PR is behind its base, Orc compares the files each side changed since the merge base.
If the two lists share no path, Orc tries to merge at the head it checked without updating the branch.
If GitHub refuses because the branch is not up to date, Orc updates the branch and waits for its checks before merging.
Orc counts both paths of a renamed file.
If GitHub returns its limit of 300 files on either side, Orc updates the branch because the lists may be incomplete.
When the lists share a path, Orc updates the branch before merging.
A beat raises an alarm for a failed push run on the default branch whichever way the PR merged, as [Main CI alarms](backlog-and-beat.md#main-ci-alarms) describes.

To update the branch, Orc prints `Updating from main` and runs `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch -f expected_head_sha=<sha>` with the head it checked.
It then prints `Checks running` and reads the PR again with `gh pr view`, first after 1 second and then at doubling waits of at most 15 seconds.
It waits until the head has moved, every check on the new head has reported and every check that was green on the checked head is green on the new head, for at most 20 minutes.
A read that fails during the wait counts as no answer, and orc keeps waiting until the 20 minutes end.
It stops waiting early once a check on the new head is red.
It reads the new head's parents and treats a head that leaves out the checked head as changed after the approval.
Once the new head is green and no longer behind, orc runs `gh pr merge <url> --squash --match-head-commit <new sha>`.

## Return without waiting for CI

For a behind PR, `orc merge <task-id> --no-wait` saves the PR link, the checked head and the checks that were green on it, requests the branch update, and returns without polling the new head or merging.
The chat always passes `--no-wait`.
The printed retry command keeps the basis of the call, as in `orc merge <task-id> --basis yolo-green --no-wait`.
Once the new head checks are green, call `merge_task` again or run that command again.
The next call reads the current head and merges nothing in these cases:

- The head leaves out the checked head from its parents.
- A check is red on the head, and orc also sends the task back for a fix.
- A check that was green on the checked head has not reported green on the head, such as a status context that has not posted yet.
- A check has not reported.

When none of those holds, the call continues as a merge without a saved update, so a head that is behind its base again gets another update request.
A merge conflict or a red check that sends the task back also drops the saved update, so the next call judges the fixed head on its own checks.

A saved check may never report again, for example when the base renamed that CI job.
Each `--no-wait` call keeps refusing until it reports green.
To get past it, run `orc merge <task-id> --basis <basis>` without `--no-wait`.
That call drops the saved checks, waits as described above for every check on the new head to report green, and merges only then.
A red check still stops it and sends the task back.

## When an update fails

Orc merges nothing and refuses when any of these holds:

- update-branch reports a merge conflict.
- A check on the new head is red.
- update-branch answers HTTP 422 because the head is no longer the one orc checked, so someone changed the PR after the approval.
- The new head leaves the checked head out of its parents, so someone changed the branch after the approval.
- The checks on the new head do not all report within 20 minutes.
- Orc still cannot read the PR when the 20 minutes end, so it cannot tell what the new head holds.
- The new head is still behind its base, because the base moved again.

After a merge conflict, or a red check observed on the new head, orc also sends the task back as [`orc backlog send-back`](backlog-tasks.md#send-a-task-back) does, with words that name the conflict or the red check.
The next beat resumes the task's run on its branch for a fix pass.

## Choose a merge basis

A project in `projects.json` may add `"yolo": true`, and a project with no `yolo` reads as `false`.
Orc refuses any `yolo` other than `true` or `false` with `the project <name> names yolo <value>, which is not true or false`.
`orc merge` takes `--basis captain-word`, the default, or `--basis yolo-green`.
The chat merges with `captain-word` only when you said to merge that PR.
It merges with `yolo-green` when you ask it to merge a yolo project's PR and the PR is green.
Orc refuses `yolo-green` for a project without `yolo` true.
Either basis meets every refusal above.

`yolo-green` also reads the PR's changed files from the GitHub pull request files API and refuses a change that waits for your merge word:

- A release, which changes `CHANGELOG.md` or the `version` of a `package.json`.
- A deletion, which removes a file.
- A workflow file change under `.github/workflows/`.
- A secret change, to a file named `.env`, `.env.<name>`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, or a name with `secret` in it.

Each such refusal ends `which waits for the captain's merge word`.
The beat merges a closed done ship task's PR on `yolo-green` by itself once its project has `yolo` true and every check is green.
A task that closed stopped or failed never auto-merges, even when its checks later turn green.
A PR with a red check or a check that has not reported stays unmerged.
A PR with a change that waits for your word stays unmerged, and its `pr-ready` item in `orc attention` names that change.

Answer `hold` to a PR's `pr-ready` item to leave that head unmerged.
The hold also covers Orc's pending branch update, but new work on the PR can lift it.
