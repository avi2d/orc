---
kind: reference
---
# Delivery modes
A project's `mode` in `projects.json` is `no-mistakes`, `direct-PR` or `no-mistakes-prod-only`, and a project with no `mode` reads as `no-mistakes`.
Orc refuses any other mode with `the project <name> names the mode <word>, which is not no-mistakes, direct-PR or no-mistakes-prod-only`.
The mode decides only how a ship task ends, and any other kind ignores it.

The beat turns the mode and the task's `internal` mark into the run's delivery and sets `ORC_TASK_DELIVERY` to `no-mistakes` or `direct-PR`.
A `no-mistakes-prod-only` project gives `direct-PR` to a task marked `internal: true` and `no-mistakes` to the rest.
`orc runner start` reads a missing `ORC_TASK_DELIVERY` as `no-mistakes` and queues a `direct-PR` ship run as `orc run <task-file> --delivery direct-PR`.

## Review the branch
A `direct-PR` run never starts [no-mistakes](https://github.com/kunchenguid/no-mistakes) and does not need it installed.
Once the checks pass, orc writes the branch diff to `diff.md` in the session folder and runs one Pi turn with the reviewer agent over that diff and the task file.
Orc decodes the findings JSON array from the reviewer's last reply and writes it to `review.json` in the run folder.
An unreadable reply gets one rerun on the same session, and a second unreadable reply fails the review turn.
The run's end reason names the finding count or the review failure.
The review turn fixes nothing and blocks nothing, so the PR opens after it either way.
A resumed direct-PR run runs the review turn again.

## Open the PR
Orc runs `git push --set-upstream origin <branch>` from the run's worktree.
It reuses the open PR for the branch when `gh pr list --head <branch> --state open` finds one, and otherwise runs `gh pr create`.
The PR's title is the head commit's subject, and its body lists the branch's commits and the checks that passed.
To resume a direct-PR run, add `--delivery direct-PR` to the resume command, and a resume without it runs no-mistakes.
Orc keeps that body as `pr-body.md` in the run folder and records the step as `pr`.

## Read the CI verdict
A `passed` verdict ends the run succeeded with the PR link, so the task closes done with it as `pr` and the chat posts it as it posts any PR.
A failed local check, a failed push or a failed `gh pr create` ends the run failed with no PR, and the task closes failed.
Once the PR opens, orc reads the GitHub check runs of the pushed head with `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` and adds a `CI verdict for <sha>:` line to the end reason.
The verdict is `passed` when every check run on that head is green, `failed` with the names of the red check runs, or `pending` while a check run is unfinished, none has reported on that head, or orc cannot read the full list.
A check run on another head never counts toward the verdict.
A `failed` verdict ends the run failed.
A `pending` verdict ends the run waiting on CI without success.
Both leave the PR open.
While the run waits, it records an open `ci-waiting` question and keeps its history row running, so the task parks with that question instead of closing failed or done.
Answering the question resumes the run, which reads the verdict again for the same head.
