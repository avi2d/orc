---
aside: false
pageClass: wide-page part-merge
kind: explanation
---
# The merge

Orc never lands a pull request on its own judgment: `orc merge <task-id>` merges a closed task's pull request, and only when it is safe.
The command exists so that the chat, the App and you all merge through one set of refusals.

![The merge: what orc merge checks before it lands a pull request](../diagrams/merge.svg)

## What the merge refuses

Orc reads the pull request with `gh pr view` and merges nothing when any of these holds.

- The task names no pull request.
- The pull request is closed or merged.
- A check is red, a check has not reported, or no check has reported at all.

Each refusal names every reason.
When the branch is behind its base, orc updates it from the base and merges once the new checks are green.
Otherwise orc squash merges at the exact commit it checked, so a push that lands after the check merges nothing.
The chat requests a branch update without waiting for CI, so a behind PR needs another merge call once the new checks are green.

## Whose word merges

A merge carries a basis, the reason it is allowed.

| Basis | When it applies |
| --- | --- |
| `captain-word`, the default | You said to merge that pull request |
| `yolo-green` | The project has `"yolo": true` in `projects.json`, and you ask the chat to merge its green pull request |

Either basis meets every refusal above.
The decider never answers a question about merging, so a merge always traces back to you.

## After the merge

A later beat reads the pull request as merged and records the event, and the chat posts it.
A ship task that waited on this one can then start.

## Related topics

- [Checks and review](checks-and-review.md)
- [Merging a task's PR](../run/merging-a-tasks-pr.md)
- [Merge a PR and turn on yolo](../merge-a-pr.md)
