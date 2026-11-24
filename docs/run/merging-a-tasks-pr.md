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

To update the branch, Orc prints `Updating from main` and runs `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch -f expected_head_sha=<sha>` with the head it checked.
It then prints `Checks running` and reads the PR again with `gh pr view`, first after 1 second and then at doubling waits of at most 15 seconds.
It waits until the head has moved, every check on the new head has reported and every check that was green on the checked head is green on the new head, for at most 20 minutes.
A read that fails during the wait counts as no answer, and orc keeps waiting until the 20 minutes end.
It stops waiting early once a check on the new head is red.
It reads the new head's parents and treats a head that leaves out the checked head as changed after the approval.
Once the new head is green and no longer behind, orc runs `gh pr merge <url> --squash --match-head-commit <new sha>`.

## Main CI alarms

Each beat identifies repositories from task PR links and the origin remotes of reachable checkouts in `projects.json`.
Task PR links keep identifying the repository after the task merges, including projects with checkouts only on worker machines.
For each reachable repository, Orc reads push workflow runs on its default branch, regardless of who merged the PR or whether Orc updated it.
Orc makes one GraphQL call per GitHub host per beat, with a 30-second timeout.
The query covers the latest 20 commits and at most 100 check suites per commit.
A failed run raises a CI alarm in Orc chat with a link to the run.
Each run raises at most one alarm across both kinds of watch.

When Orc merges a behind PR without updating it, the next beats also watch push workflow runs at the squash commit on that PR's base branch.
Those alarms include the PR link.
The watch ends once every run has finished, or if no run exists 30 minutes after the PR merged.
A running workflow keeps the watch open past that window.
A failed or unreadable request does not count as an empty run list.

## When an update fails

Orc merges nothing and refuses when any of these holds:

- update-branch reports a merge conflict.
- A check on the new head is red.
- update-branch answers HTTP 422 because the head is no longer the one orc checked, so someone changed the PR after the approval.
- The new head leaves the checked head out of its parents, so someone changed the branch after the approval.
- The checks on the new head do not all report within 20 minutes.
- Orc still cannot read the PR when the 20 minutes end, so it cannot tell what the new head holds.
- The new head is still behind its base, because the base moved again.

After a merge conflict or a red check on the new head, orc also sends the task back as [`orc backlog send-back`](backlog-tasks.md#send-a-task-back) does, with words that name the conflict or the red check.
The next beat resumes the task's run on its branch for a fix pass.

## Choose a merge basis

A project in `projects.json` may add `"yolo": true`, and a project with no `yolo` reads as `false`.
Orc refuses any `yolo` other than `true` or `false` with `the project <name> names yolo <value>, which is not true or false`.
`orc merge` takes `--basis captain-word`, the default, or `--basis yolo-green`.
The chat merges with `captain-word` only when you said to merge that PR.
It merges with `yolo-green` when you ask it to merge a yolo project's PR and the PR is green.
Orc refuses `yolo-green` for a project without `yolo` true.
Either basis meets every refusal above.
