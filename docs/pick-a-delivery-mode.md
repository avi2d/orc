---
kind: reference
---
# Pick a delivery mode
Each project in `projects.json` can name a `mode` that decides how its ship tasks reach a pull request:

- `no-mistakes`, the default, runs the checks and then no-mistakes, which opens the pull request.
- `direct-PR` runs the checks, then pushes the branch and opens the pull request itself.
- `no-mistakes-prod-only` runs no-mistakes unless a task is marked internal, and then works as `direct-PR`.

To mark a task internal, add `--internal` to `orc backlog add`, or say so in the chat.
The task file keeps the mark, and the other two modes ignore it.
A failed check closes a `direct-PR` task failed with no push and no pull request.
The chat posts a `direct-PR` task's pull request the same way as any other.
Orc refuses any other mode with a message that names the project.
