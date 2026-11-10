---
kind: reference
---
# Delivery modes
A project's `mode` in `projects.json` is `no-mistakes`, `direct-PR` or `no-mistakes-prod-only`, and a project with no `mode` reads as `no-mistakes`.
Orc refuses any other mode with `the project <name> names the mode <word>, which is not no-mistakes, direct-PR or no-mistakes-prod-only`.
The mode decides only how a ship task ends, and a scout, task or parent ignores it.

The beat turns the mode and the task's `internal` mark into the run's delivery and sets `ORC_TASK_DELIVERY` to `no-mistakes` or `direct-PR`.
A `no-mistakes-prod-only` project gives `direct-PR` to a task marked `internal: true` and `no-mistakes` to the rest.
`orc runner start` reads a missing `ORC_TASK_DELIVERY` as `no-mistakes` and queues a `direct-PR` ship run as `orc run <task-file> --delivery direct-PR`.

A `direct-PR` run never starts no-mistakes and does not need it installed.
Once the checks pass, it runs `git push --set-upstream origin <branch>` from the run's worktree.
It reuses the open PR for the branch when `gh pr list --head <branch> --state open` finds one, and otherwise runs `gh pr create`.
The PR's title is the head commit's subject, and its body lists the branch's commits and the checks that passed.
To resume a direct-PR run, add `--delivery direct-PR` to the resume command, and a resume without it runs no-mistakes.
Orc keeps that body as `pr-body.md` in the run folder and records the step as `pr`.
The run succeeds with the PR link, so the task closes done with it as `pr` and the chat posts it as it posts any PR.
A failed check, a failed push or a failed `gh pr create` ends the run failed with no PR, and the task closes failed.
