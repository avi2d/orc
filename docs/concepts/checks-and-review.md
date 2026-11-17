---
aside: false
pageClass: wide-page part-checks
kind: explanation
---
# Checks and review

A code change passes two gates before you see it: the project's own checks, and a review.
Both run inside the run, so a pull request that reaches you has already passed them.

![Checks and review: the two gates a code change passes](../diagrams/checks.svg)

## The checks

The project names its checks in a `.no-mistakes.yaml` file at its root, under `commands`.
Orc runs them in the run's copy after Pi finishes.
When a check fails, orc starts a fixer Pi with the failing output, then runs the checks again.
After 3 fix attempts with a check still red, the run ends failed and no pull request opens.

## The review

On a `no-mistakes` run, orc hands the checked branch to no-mistakes with the task as its intent.
No-mistakes reviews the branch, pushes it, opens the pull request and reports when CI is green.
At each of its gates orc answers for you where it safely can.

| Finding marked | What orc does |
| --- | --- |
| `auto-fix` | Asks no-mistakes to fix it |
| `no-op` | Ignores it |
| `ask-user` | Treats it as a question, and waits for an answer |

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
