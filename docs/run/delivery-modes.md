---
kind: reference
---
# Delivery modes
A project's `mode` in `projects.json` is `no-mistakes`, `direct-PR`, `orc`, or `no-mistakes-prod-only`.
A project with no `mode` reads as `no-mistakes`.
Orc refuses any other mode with `the project <name> names the mode <word>, which is not no-mistakes, direct-PR, orc or no-mistakes-prod-only`.
The mode decides only how a ship task ends, and any other kind ignores it.
A `direct-PR` or `orc` run never starts [no-mistakes](https://github.com/kunchenguid/no-mistakes) and does not need it installed.

The beat turns the mode and the task's `internal` mark into the run's delivery and sets `ORC_TASK_DELIVERY` to `no-mistakes`, `direct-PR`, or `orc`.
A `no-mistakes-prod-only` project gives `direct-PR` to a task marked `internal: true` and `no-mistakes` to the rest.
`orc runner start` reads a missing `ORC_TASK_DELIVERY` as `no-mistakes` and queues a `direct-PR` ship run as `orc run <task-file> --delivery direct-PR`.

## Orc delivery
An `orc` run fetches `origin` and rebases its branch onto the default branch recorded by `refs/remotes/origin/HEAD` before running the project checks.
If the rebase fails, the run does not open a PR.
After the checks pass, the run pushes the branch and opens or reuses a PR.
Between the checks and the push, the run reviews the branch and fixes the findings in at most two rounds, and it does not wait for a CI verdict.
To select this delivery for a project, set its `mode` to `orc` in `projects.json`.
For a run or resume you start by hand, pass `--delivery orc`.

## Review the branch
Once the configured local checks pass, orc writes the branch diff to `diff.md` in the session folder and runs one [Pi](https://pi.dev) turn with the reviewer agent over that diff and the task file.
Orc decodes the findings JSON array from the reviewer's last reply and writes it to `review.json` in the run folder.
An unreadable reply gets one rerun on the same session, and a second unreadable reply fails the review turn.
The run's end reason names the finding count or the review failure.
The run history records the turn as the `review` step with its start and end time and the reviewer's model.
A passed `review` step names `review.json` as evidence and gives the finding count as the `review-findings` signal.
A failed `review` step gives the failure as the `review-failure` signal.
The review turn fixes nothing and blocks nothing, so the PR opens after it either way.
After a successful review, if orc can read the branch head, it writes `review-checkpoint.json` in the run folder with the head and findings.
A resumed direct-PR run reads the previous run's checkpoint and reuses the completed review when the branch head is unchanged.
It writes the findings to `review.json` and a new checkpoint in the current run folder.
If the head changed or no completed review was recorded, orc runs the review turn.
Failed review turns are not recorded for reuse, so a resume retries them.
A checkpoint write failure does not block the PR, but the next resume runs the review again.

## Open the PR
After the review turn, a direct-PR run runs `git push --set-upstream origin <branch>` from the run's worktree.
It reuses the open PR for the branch when `gh pr list --head <branch> --state open` finds one, and otherwise runs `gh pr create`.
The PR's title is the head commit's subject, and its body lists the branch's commits and the local checks that passed.
The body then lists each open review finding with its severity, id, `file:line`, description and action.
A review with no findings gives the line `The review found nothing.`, and a failed review turn gives `The review turn failed, so this PR lists no review findings.`
An `orc` run opens its PR the same way, with the findings left after its last fix round.
To resume a direct-PR run, add `--delivery direct-PR` to the resume command, and a resume without it runs no-mistakes.
Orc keeps that body as `pr-body.md` in the run folder and records the step as `pr`.

## After the PR opens
A direct-PR run succeeds as soon as the PR opens.
A failed local check, push, or PR creation ends the run failed.
The beat [retries a confirmed failed run once](attention-queue.md#retry-a-dead-run-once) before closing the task failed.
The beat reads the open PR and places it in the attention queue when its checks are green.
