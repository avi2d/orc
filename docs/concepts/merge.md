---
aside: false
pageClass: wide-page part-merge
kind: explanation
---
# The merge

`orc merge <task-id>` merges a closed task's pull request, and only when it is safe.
The command exists so that the chat, the App, the beat and you all merge through one set of refusals.

![The merge: what orc merge checks before it lands a pull request](../diagrams/merge.svg)

## What the merge refuses

Orc reads the pull request with `gh pr view` and merges nothing when any of these holds.

- The task names no pull request.
- The pull request is closed or merged.
- A check is red, a check has not reported, or no check has reported at all.

Each refusal names every reason.
When the branch is behind its base and neither side changed a file the other did, orc merges without updating it.
When they share a changed file, orc updates the branch from the base and merges once the new checks are green.
Orc updates it the same way when GitHub refuses the branch as out of date.
Each beat raises an alarm when a push run on the default branch fails.
Otherwise orc squash merges at the exact commit it checked, so a push that lands after the check merges nothing.
The chat requests a branch update without waiting for CI, so a behind PR needs another merge call once the new checks are green.
That call checks the new head against the checks that were green before the update.
A plain `orc merge` drops those saved checks and waits for the new head's own checks instead.

## Whose word merges

A merge carries a basis, the reason it is allowed.

| Basis | When it applies |
| --- | --- |
| `captain-word`, the default | You said to merge that pull request |
| `yolo-green` | The project has `"yolo": true` in `projects.json`, and the beat finds its pull request green or you ask the chat to merge it |

Either basis meets every refusal above.
`yolo-green` also refuses a release, a deletion, a workflow file change or a secret change, which wait for your word and show in `orc attention`.
The decider never answers a question about merging, so a merge traces back to your word or to the `yolo` you set.
The beat merges only a task that closed done, and a task that closed stopped or failed never auto-merges.

## After the merge

A later beat reads the pull request as merged and records the event, and the chat posts it.
A ship task that waited on this one can then start.

## Related topics

- [Checks and review](checks-and-review.md)
- [Merging a task's PR](../run/merging-a-tasks-pr.md)
- [Merge a PR and turn on yolo](../merge-a-pr.md)
