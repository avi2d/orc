---
kind: reference
---
# Pick a delivery mode
Each project in `projects.json` can name a `mode` that decides how its ship tasks reach a pull request:

- `no-mistakes`, the default, runs the checks and then [no-mistakes](https://github.com/kunchenguid/no-mistakes), which opens the pull request.
- `direct-PR` runs the checks, then a [review turn that records findings without blocking](run/delivery-modes.md), then pushes the branch and opens the pull request itself.
- `orc` rebases onto the default branch, runs the checks, [reviews the branch and fixes the findings](run/delivery-modes.md#orc-delivery) in up to two rounds by default, and opens the pull request without a CI verdict.
  A failed review, a fix that does not finish, or a check that fails after a fix stops the run before a pull request opens.
- `no-mistakes-prod-only` runs no-mistakes unless a task is marked internal, and then works as `direct-PR`.

To mark a task internal, add `--internal` to `orc backlog add`, or say so in the chat.
The task file keeps the mark, and the other modes ignore it.
A failed check closes a `direct-PR` task failed with no push and no pull request.
The chat posts a `direct-PR` task's pull request the same way as any other.
Orc refuses any other mode with a message that names the project.
