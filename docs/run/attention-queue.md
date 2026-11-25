---
kind: reference
---
# The attention queue

Run `orc attention` to see questions and events that need an answer.
The queue is kept in `~/.orc/backlog/attention`.
Each item names its task, kind, owner, text, and age.
An open item becomes overdue after five minutes.

Review and worker questions start with the decider.
A gate finding whose action is not `auto-fix`, `no-op`, or `ask-user` stays with you, so the decider never answers it.
Looping runs, failing commands, overdue holds, and run or PR events need you.
Three consecutive failures of one command open a notification, and six open a looping question.
See [Parked runs](parked-runs.md) for worker questions and looping runs.

## The decider

The beat sends each open question owned by the decider to `models.decider`.
The call has no tools.
It receives the task, earlier answers, the question, `<ORC_HOME>/orchestrator.md`, and the project's instructions when present.
Its policy is in `packages/run/agents/decider-policy.md`.

No-mistakes names the action it asks of you in the `question_action` column of each `ask-user` finding and each `question-<id>` finding.
Orc carries that value through `asking.json`, the run history and the parked question in the task file.
A review finding is a row of the no-mistakes findings table, and a review question is a `question-<id>` row.
Orc's own `gate-cap` and `ci-waiting` questions count as review questions.
No-mistakes writes `unknown` for an `ask-user` finding its reviewer did not classify.
A review finding with no `question_action`, or with `none` or `unknown`, goes to the decider without a topic check, because a finding describes code.
A review question with a missing or `unknown` action falls back to the topic check on its text.
The action `none` bypasses the topic check.
The actions `merge`, `delete`, `login`, `push`, and `release` go to you.
Any other action value goes to you because orc does not know it.

### The topic check

The topic check sends questions about deletion, security, credentials, merging, pushing, releasing, going public, spending, irreversible actions, site appearance, legal text, and logins to you.
For a worker question, or a review question with a missing or `unknown` action, it reads the whole question, including context and reports of completed actions.
Those questions go to you if they name `merge conflicts` or say a step pushes a tag, even if they only ask whether to continue.
Going public means making something public, doing it publicly, or posting, announcing, emailing or sharing to an outside place such as a client, a channel or an issue.
An upstream repository, issue or project, or a service such as a gist, Discord, Slack or Reddit, counts on its own.
The word public or share alone, as in `public API`, does not count.
Dropping, discarding, scrapping, resetting, reverting, restoring, or throwing away or out commits, changes, edits, modifications, diffs, work, a stash or what you changed counts as deleting work.
Singular change or edit counts after my, our, your, this, that, the local, or uncommitted.
The noun counts within three words after the verb without a joining word such as `in`, or before a past form such as `discarded`.
Own work needs a helper verb before the past form, as in `will be discarded` or `will be scrapped`.
A hard reset, `git reset --hard`, `git branch -D`, `git stash drop` or `clear`, `git clean -f`, `git checkout -- .` and `git restore .` also count.
The name `test runs` never counts as deleting work.
Any question or finding with no words goes to you, regardless of its action.
The topic check uses the fixed word list in `packages/run/src/features/decider/decider-guard.ts`.
Rules and policy do not widen either check.

### Reply to a question

The decider can:

- **Answer** with a reason and a rule from the task, your rules, project instructions, or the policy's Rules section.
  Orc escalates an answer whose quote is no whole clause of them, after whitespace is collapsed and surrounding quotes and a leading list or quote marker are stripped.
  A quote matches a whole line or paragraph, a sentence in a line, or a sentence of a paragraph joined across lines, starting at the start or after a period, exclamation mark, question mark, colon, or semicolon and ending at the end, before a mark, or on a mark.
  Quote marks and clause punctuation may differ, orc records the source wording, and meaning-changing marks stay exact.
- **Ask back** to a worker question.
  The worker receives the question and the item stays open.
  A review question cannot be asked back and is escalated instead.
- **Link a duplicate** to an earlier answered question on the same task.
  Orc escalates a link to a missing or unanswered item.
- **Escalate** to you, with a reason and the bullet of the policy's Escalation list it rests on.
  When the question lists lettered options, the decider may name the one it recommends.
  The escalated decision keeps that option's text as `recommendation`, and orc drops a recommendation that is no option of the question.

### Follow the recommended option

A line of a question that starts with `Recommended:` names its recommended option, and leading whitespace before it is allowed.
The policy tells the decider to answer such a question with that option, even when it picks between product choices the intent leaves open or the decider is not sure.
When the decider still escalates a question with that line on one of those two bullets, orc answers it with the recommended option and records the policy's Rules sentence as the rule.
An escalation on any other bullet, or with no bullet, stays with you, and so does a question on the topic list above.
When the decider answers a question on that Rules sentence, orc records the question's `Recommended:` option as the answer, whatever option the reply named.
Orc escalates such an answer to a question with no `Recommended:` line.
The rule and the override apply to worker questions, review questions and review findings alike, once they reach the decider.

### Settle routine review findings

The policy's Rules section settles these findings when they reach the decider:

- A fix round that landed no diff gets `fix with instructions`, and orc sends the answers to the review's other findings with the fix.
- A missing changelog entry, in a repository whose release writes the changelog from commit subjects, gets the commit subject as its entry.
- A merge conflict with the base branch or a failed check gets a fix from the run, which then runs the checks again.
- A finding with one remedy inside the task's intent and one that widens it gets the remedy inside the intent.

A worker question or a review question without an action still goes to you if it names a merge conflict or a release.

### Handle a failed call

A failed call, unreadable reply or rules file, or missing decider model also escalates the item.

## Overturning a decider answer
The decider never has the last word.
To replace an answer the decider gave, run `orc backlog answer <task-id> <question-id>=<text>`.
Your answer stands, and the task file keeps the decider's answer beside it under `overturned`.
The item keeps the decider's answer under `overturned` in its `closed` state, and its `answer` is yours.
A run that has not received the decider's answer gets only yours.
If a run already took the decider's answer, `orc backlog answer` says the next beat queues your answer as a correction and that delivery is not confirmed.
The next beat writes the correction to `corrections.json`, and that write fails if the run has already ended.
The task file marks it `correction_queued`, and later beats do not queue it again.
A Pi worker may receive the correction after its next tool call.
No Pi worker reads corrections during a [no-mistakes](https://github.com/kunchenguid/no-mistakes) gate or after the last Pi session ends.
A closed task refuses the answer, because its run is over.
A second answer never replaces yours.

## Answering an item
Answering a review question or a worker question with `orc backlog answer <task-id> <question-id>=<text>` closes the item.
A question asked again with the same words keeps its item.
A question asked again with different words opens a new item, and the old item is withdrawn.
An answered question asked again opens a new item, and the old item keeps its answer.

## Items for run events

The beat opens an item for each run event, owned by the user:

- A run that died opens a `run-died` item, when its task closes failed or its start fails.
  A run that ends done or that you stop opens none.
  Two failures retry instead of opening the item.
  When no-mistakes refuses to start because the repository is not initialized, the run runs `no-mistakes init --skip-user-skill` and starts no-mistakes again.
  When the command that reaches a dispatch machine exits 255, as ssh does when its connection fails, the task stays started and the next beat reads it again.
- A dispatch machine that orc has not reached for 10 minutes, counted from the first beat that could not reach it, opens a `machine-unreached` item for each started task on that machine.
  Each item names the machine and the error of the command that reaches it, and the task stays started.
  A beat that reaches the machine again withdraws the item, and so does closing its task.
- A red check on a closed ship task's PR opens a `check-red` item for the PR's head commit.
  Checks that turn green on that commit, or a new commit, withdraw it.
  Merging the PR or closing it without merging withdraws it.
- A closed ship task's PR with every check reporting green opens a `pr-ready` item for its head commit.
  A red check or a new commit withdraws it.
  On a project with `yolo` true, the item text names each change that waits for your merge word.
  Merging the PR closes it with the answer `merged`.
  Closing the PR without merging closes it with the answer `closed without merging`.

### Items for update failures

A failed [update check](beat-runs.md#updating-orc-on-dispatch-machines) opens an `update-failed` item for a dispatch machine.
A retry that fails for the same version updates the open item without replacing any answer.
A successful check withdraws the open item.
Use `orc attention answer <item-id> <words>` to record an acknowledgement.
A retry that fails again before a check succeeds leaves the answered item closed.
After a successful check, the next failure opens a new item and the answered item keeps its answer.

## Recording a choice

The following items name a `subject` and list `options`, each with the `outcome` it leads to.
The `recommendation` names one option:

- A `run-died` item offers `rerun` or `close`, and recommends `rerun`.
- A `check-red` item offers `send back` or `close`, and recommends `send back`.
- A `pr-ready` item offers `merge` or `hold`, and recommends `merge`.
- A `failing-command` item offers `continue` or `stop`, and recommends `continue`.
- A `machine-unreached` item offers `wait` or `close`, and recommends `wait`.
- An `overdue-wait` item offers `answer` or `drop`, and recommends `answer`.

To record a choice on a `run-died`, `check-red`, `pr-ready`, `failing-command` or `machine-unreached` item, run `orc attention answer <item-id> <words>`.
Run the command the outcome names to carry out the option.
`orc attention answer` only records the choice and closes the item.
It refuses a review question, a worker question or an overdue wait and names the task to answer with `orc backlog answer` instead.

A held task whose `--until` date has passed opens an `overdue-wait` item, owned by the user and asked at the start of the next day on the machine local clock.
Answering the hold closes the item with the hold's answer.

## Seeing the queue

Each beat reads the queue before it starts a new task, and prints one `needs the <owner> <item-id>: <text>` line per open item, oldest first, with `, overdue` after the owner for an overdue one.
Run `orc attention` to see open items in age order.
The text view shows the decider's answers under `Decided:`.
Run `orc attention --json` for an `orc.attention.v1` document with `at`, `items`, and `decided`.
An open item in `items` carries its `subject`, `options` and `recommendation` when it has them.
The output shape is in `packages/run/src/features/attention-list/attention-view.ts`.
Closing a task withdraws the items open at the time of the close.
The beat can open new items about the run's failure or the PR it tracks after the close.
An answered item leaves `decided` when its task closes.

Run `orc backlog thread <task-id>` to see one task's items alongside its holds, questions, answers, and notes.
On a machine without a backlog, the JSON command prints an empty queue.

## Run the attention tool

To run the live attention panel, run `orc-dash panel attention`.
It runs alone in a plain terminal or in a [Herdr](https://herdr.dev) pane.
The panel reads `orc attention --json` on the machine it runs on and nothing else, and paints again every 10 seconds.
The dashboard shows it by default, above the resources panel in a wide layout and second in the narrow glance, as [Lay out the dashboard](../dash-dashboard.md#lay-out-the-dashboard) shows.
It shows each open item oldest first, with its task, its owner, its age and its kind, and its text below.
An overdue item starts with `!` and says `overdue` after its age.
The head counts the open items and the overdue ones.
With no open item, it says `nothing needs anyone`.
Without `orc` on the `PATH`, it says `orc` is not installed.
To print one frame of plain text instead, run `orc-dash panel attention --print`.
