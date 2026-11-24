---
aside: false
pageClass: wide-page part-checks
kind: explanation
---
# Checks and review

A code change passes the project's own checks before you see it.
Most code changes also pass a review.
Each runs inside the run, so a pull request that reaches you has already passed what its delivery mode names.

![Checks and review: the two gates a code change passes](../diagrams/checks.svg)

## The checks

The project names its checks in a `.no-mistakes.yaml` file at its root, under `commands`.
Orc runs only `build`, `lint`, and `typecheck` as local checks in the run's copy after Pi finishes.
It runs `prepare` before Pi starts and skips every other command.
Orc refuses any of those four commands that invoke a local test runner and names the test call in the error.
It follows package scripts, including their `pre` and `post` scripts, to find test calls.
The shared rule also blocks tests in Pi sessions through the heavy-queue stand-ins.
It recognizes `checks-test`, `bun test`, test executables such as Vitest and Jest, and `e2e` executable or leaf targets.
Recognized package scripts include `test`, `tests`, `t`, `tst`, `e2e`, `coverage`, and `mutation`.
The rule also recognizes `test:*`, `tests:*`, `e2e:*`, `coverage:*`, and `mutation:*`.
A path passed to another tool, such as `tests/e2e` passed to a linter, does not name a test runner.
GitHub CI runs repository tests and decides whether the run completes.
When a local check fails, orc starts a fixer Pi with the failing output, then runs the local checks again.
After 3 fix attempts with a local check still red, the run ends failed and no pull request opens.
Follow the local check and GitHub CI policy in [Local checks and CI](../run/running-a-task.md#local-checks-and-ci).

## The review

On a `no-mistakes` run, orc hands the checked branch to [no-mistakes](https://github.com/kunchenguid/no-mistakes) with the task as its intent.
No-mistakes reviews the branch, pushes it, opens the pull request and reports when CI is green.
Orc skips the local Test step and tells the review fixer to leave repository tests to CI.
At each of its gates orc answers for you where it safely can.

| Finding marked | What orc does |
| --- | --- |
| `auto-fix` | Asks no-mistakes to fix it |
| `no-op` | Ignores it |
| `ask-user` | Treats it as a question, and waits for an answer |
| Any other action, or none | Treats it as a question, and waits for an answer |

After orc answers 20 gates in one run without an outcome, it asks the question `gate-cap` before it answers more.
An answer to `gate-cap` lets orc answer 20 more gates.

A run with an open question waits at the gate for 30 minutes.
An answer in that time carries the run on at the same gate.
With no answer, the task parks on its branch, and the beat resumes it on the same machine once every question has an answer.

## The delivery modes

A project's `mode` in `projects.json` decides how its ship tasks end.

| Mode | How a ship task ends |
| --- | --- |
| `no-mistakes`, the default | Checks, then the no-mistakes review, then a pull request with green CI |
| `direct-PR` | Checks, then orc pushes the branch and opens the pull request itself |
| `no-mistakes-prod-only` | `direct-PR` for a task marked internal, `no-mistakes` for the rest |

## Related topics

- [A run](run.md)
- [The attention queue](attention.md)
- [Delivery modes](../run/delivery-modes.md)
- [Parked runs](../run/parked-runs.md)
- [Pick a delivery mode](../pick-a-delivery-mode.md)
