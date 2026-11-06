---
kind: reference
---
# What the no-mistakes fork adds
Orc is developed against the avi2d/no-mistakes fork, and runs on upstream no-mistakes too.
The fork sends and prints the same axi commands, flags and fields as upstream v1.100.2.
These fork changes alter what a run meets, and the table names what happens on upstream without each.

| Fork change | What happens on upstream |
| --- | --- |
| A fresh run may replace an aborted run's unpublished mirror head | After a run aborts before its push and a commit leaves the branch, orc reports `no-mistakes refused to start` with `refusing to reconcile private mirror ref`, and the task needs a new branch |
| A fix round may only add commits | A fix agent that rebases or amends leaves the run failed and its branch off the recorded head, and orc reports the run failed with no-mistakes' error |
| Commits a fix agent makes take the worktree identity | A fix commit can carry the `no-mistakes <no-mistakes@local>` identity, so a project whose checks hold commit identity fails CI, and orc reports the run failed |
| A `reviewer_chain` setting falls through to the next reviewer when one is out of quota | Upstream has no `reviewer_chain`, so a reviewer out of quota fails the review step, and orc reports the run failed with no-mistakes' error |
| `pr.title_max_length` shortens a drafted PR title over the limit | Upstream has no `pr.title_max_length` and keeps the drafted title whole, so a project whose checks limit title length fails CI, and orc reports the run failed |
| The review step runs no agent when a branch changes only doc files or only workflow `cron:` values | Upstream reviews those branches with its agent, so the run spends a review and can stop at a review gate orc answers |
| Under `rebase.strategy: merge`, a CI conflict repair merges the base into the published branch | Upstream's repair rebases the published branch, so the next push can be refused, and orc reports the run failed with no-mistakes' error |

When a no-mistakes run ends failed, orc's result carries the error no-mistakes printed for it.
