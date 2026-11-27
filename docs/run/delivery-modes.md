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
After the checks pass, the run reviews the branch and fixes the findings in at most two rounds.
The first round fixes every finding, and the second round fixes only the `error` findings the next review still reports.
The run history records each review turn as its own `review` step, numbered by attempt.
If a review turn fails, a fix does not finish, or a check fails after a fix, the run stops without opening a PR.
Otherwise, the run pushes the branch and opens or reuses a PR.
The run does not wait for a CI verdict.
To select this delivery for a project, set its `mode` to `orc` in `projects.json`.
For a run or resume you start by hand, pass `--delivery orc`.

## Review the branch
Once the configured local checks pass, orc writes the branch diff to `diff.md` in the session folder and runs one [Pi](https://pi.dev) turn with the reviewer agent over that diff and the task file.
In `orc` delivery, orc also reads `review.path_instructions` from `.no-mistakes.yaml` in the run's worktree.
Each entry holds a `path` glob and its `instructions`.
Orc adds each entry whose glob matches a changed file to the review prompt, and the reviewer names that glob in each finding the entry raises.
An entry missing either string fails the review turn.
Orc decodes the findings JSON array from the reviewer's last reply and writes it to the run folder as `review.json`, then `review-2.json` and `review-3.json` in later orc turns.
An unreadable reply gets one rerun on the same session, and a second one fails the review turn.
The run's end reason names the finding count or the review failure.
The run history records the turn as the `review` step with its times and the reviewer's model.
A passed `review` step names its findings file as evidence and gives the finding count as the `review-findings` signal.
A failed `review` step gives the failure as the `review-failure` signal.
In `direct-PR` delivery, the review turn fixes nothing, and a review failure does not block opening the PR.
After a successful `direct-PR` review, if orc can read the branch head, it writes `review-checkpoint.json` in the run folder with the head and findings.
A resumed direct-PR run reads the previous run's checkpoint and reuses the completed review when the branch head is unchanged.
It writes `review.json` and a new checkpoint in the current run folder.
If the head changed or no completed review was recorded, orc runs the review turn.
A checkpoint write failure does not block the PR, but the next resume reviews again.

## Reviewer chain
The optional `reviewers` list in `config.json` gives an `orc` run an ordered chain of reviewers, as [Configuring providers](configuring-providers.md#reviewer-chain) shows.
Without it, the review turn runs the reviewer agent on its usual model.
With it, orc picks the reviewer before each review turn:

1. Orc runs the quota command in `dispatch.json` once, as [Accounts on other providers](backlog-configuration.md#accounts-on-other-providers) describes.
2. Orc skips every provider that ran an implementation or fix step on this branch, in any run, even when the step was interrupted or made no commit.
3. For each other entry, orc reads the quota account that holds the provider's default credential in `config.json`, because the review turn runs on that credential.
4. Orc takes the first entry whose account is at or above `floorPercent`, and the review turn runs the reviewer agent on that entry's model.

The account that holds the default credential is one of these:

- For a `token-file` provider, the `token-file` account whose `tokenFile` is the provider's token file.
- For a `package` provider whose `env` names `CLAUDE_CONFIG_DIR`, the `claude-config` account with that folder.
- For any other provider, its one account in the quota.

Another account on the same provider does not count, even with room.
An unreadable quota, or no account that holds the default credential, counts as no room.
The run log names the chosen model, its place and each entry passed over, with the reason.
A chain reviewer runs Pi with its own provider's credential.
For a `token-file` or `package` provider, it runs from its own Pi folder `reviewer-agent-<position>` in the run folder.
The [nono](https://nono.sh) sandbox carries one provider's credential, so a reviewer chain needs `--sandbox none`.

## No reviewer room
When no entry qualifies, Orc records `NoReviewerRoom` and does not open a PR.
The run history records the `review` step as failed with no model, and the `review-failure` signal holds the reason.
The beat parks the task with that reason and checks reviewer quota on the machine where the run stopped.
When a reviewer qualifies, the beat resumes the same branch.
The resumed run keeps the implementation, runs the checks again and then runs the pending review turn.
It does not apply again a send-back that the parked run already applied.
A new send-back runs the implementer again and starts a fresh review cycle with up to two fix rounds.
The resumed run excludes the providers saved when it parked.
An account that dispatch assigns to the resumed run can still review until its provider runs an implementation or fix step.
If the run parks again, it saves the updated list of excluded providers for the beat.

## Open the PR
After the review turn, a direct-PR run runs `git push --set-upstream origin <branch>` from the run's worktree.
It reuses the open PR for the branch when `gh pr list --head <branch> --state open` finds one, and otherwise runs `gh pr create`.
The PR's title is the head commit's subject.
Orc keeps the body as `pr-body.md` in the run folder and records the step as `pr`.
To resume a direct-PR run, add `--delivery direct-PR` to the resume command, and a resume without it runs no-mistakes.

## The PR body
The body keeps the same headings in the same order on every run.
`## Why` holds the one sentence that the diagram turn writes from the branch diff, never text from the task file.
When the turn returns no such sentence, or the sentence repeats eight consecutive words from the task file, it holds `No reason was recorded for this change; see What changed.`
When the task file cannot be read, the reason is kept.
`## What changed` lists the branch's commits.
`## How it fits` carries a `mermaid` diagram when the change alters a flow, a structure or a boundary, and the run leaves the heading out otherwise.
A further Pi turn writes the `## Why` sentence and draws that diagram after the push, and only when `gh pr create` is about to run.
A run that opens no PR, and a run that reuses an open PR, skip it.
A reply without a `mermaid` fence leaves the heading out, and so does a diagram that repeats eight consecutive words from the task file.
When the task file cannot be read, the diagram is kept.
`## How it was checked` names the local checks that passed and the review result.
A review with no findings gives the line `The review found nothing.`, and a failed review turn gives `The review turn failed, so this PR lists no review findings.`
`## Open review findings` lists each open finding with its severity, id, file and line, description and action, and the run leaves the heading out when no finding is open.

## Findings left open
After a successful review and any fix rounds, an `orc` run opens its PR the same way, with the remaining findings.
Findings that remain after the fix rounds do not stop the PR.
Under each remaining finding, a nested line says why the fix loop left it.
A `warning` or `info` finding is below the round 2 bar, which fixes only errors.
For an `error` finding with the same id and file as one the fixer already received, the reason line names that match and the round.
Any other `error` finding came from the review after fix round 2, so the round limit was reached.
Orc does not yet mark a finding as left because it needs a person's decision.

## After the PR opens
A direct-PR run succeeds as soon as the PR opens.
A failed local check, push, or PR creation ends the run failed.
The beat [retries a confirmed failed run once](attention-queue.md#retry-a-dead-run-once) before closing the task failed.
The beat reads the open PR and places it in the attention queue when its checks are green.
