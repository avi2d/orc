---
kind: reference
---
# The attention queue

Run `orc attention` to see questions and events that need an answer.
The queue is kept in `~/.orc/backlog/attention`.
Each item names its task, kind, owner, text, and age.
An open item becomes overdue after five minutes.

Review and worker questions start with the decider.
Looping runs, failing commands, overdue holds, and run or PR events need you.
Three consecutive failures of one command open a notification, and six open a looping question.
See [Parked runs](parked-runs.md) for worker questions and looping runs.

## The decider

The beat sends each open question owned by the decider to `models.decider`.
The call has no tools.
It receives the task, earlier answers, the question, `<ORC_HOME>/orchestrator.md`, and the project's instructions when present.
Its policy is in `packages/run/agents/decider-policy.md`.

Orc sends questions about deletion, security, credentials, merging, pushing, releasing, spending, irreversible actions, site appearance, legal text, and logins to you instead.
The topic check uses the fixed word list in `packages/run/src/features/decider/decider-guard.ts`.
Rules and policy do not widen it.

The decider can:

- **Answer** with a reason and an exact rule from the task, your rules, project instructions, or policy.
  Orc escalates an answer whose quote is no whole clause of them, after whitespace is collapsed and surrounding quotes and a leading list or quote marker are stripped on both sides.
  A quote matches a whole line, a sentence within a line, a whole paragraph joined across its lines, a sentence of that joined paragraph, where the quote starts at the start or after a period, exclamation mark, question mark, colon or semicolon and ends at the end, just before one of those marks, or on one of those marks.
- **Ask back** to a worker question.
  The worker receives the question and the item stays open.
  A review question cannot be asked back and is escalated instead.
- **Link a duplicate** to an earlier answered question on the same task.
  Orc escalates a link to a missing or unanswered item.
- **Escalate** to you, with a reason.

A failed call, unreadable reply or rules file, or missing decider model also escalates the item.

## Overturning a decider answer
The decider never has the last word.
To replace an answer the decider gave, run `orc backlog answer <task-id> <question-id>=<text>`.
Your answer stands, and the task file keeps the decider's answer beside it under `overturned`.
The item keeps the decider's answer under `overturned` in its `closed` state, and its `answer` is yours.
A run that has not received the decider's answer gets only yours.
A live run that already has it gets yours as a correction after its next tool call.
A closed task refuses the answer, because its run is over.
A second answer never replaces yours.

## Answering an item
Answering a review question or a worker question with `orc backlog answer <task-id> <question-id>=<text>` closes the item.
A question asked again with the same words keeps its item.
A question asked again with different words opens a new item, and the old item is withdrawn.
An answered question asked again opens a new item, and the old item keeps its answer.

The beat opens an item for each run event, owned by the user:

- A run that died opens a `run-died` item, when its task closes failed or its start fails.
  A run that ends done or that you stop opens none.
- A red check on a closed ship task's PR opens a `check-red` item for the PR's head commit.
  Checks that turn green on that commit, or a new commit, withdraw it.
  Merging the PR or closing it without merging withdraws it.
- A closed ship task's PR with every check reporting green opens a `pr-ready` item for its head commit.
  A red check or a new commit withdraws it.
  Merging the PR closes it with the answer `merged`.
  Closing the PR without merging closes it with the answer `closed without merging`.

Each item the beat opens names its `subject` and lists its `options`, each with the `outcome` it leads to, and its `recommendation` names one of them:

- A `run-died` item offers `rerun` or `close`, and recommends `rerun`.
- A `check-red` item offers `send back` or `close`, and recommends `send back`.
- A `pr-ready` item offers `merge` or `hold`, and recommends `merge`.
- A `failing-command` item offers `continue` or `stop`, and recommends `continue`.
- An `overdue-wait` item offers `answer` or `drop`, and recommends `answer`.

To record a choice on a `run-died`, `check-red`, `pr-ready` or `failing-command` item, run `orc attention answer <item-id> <words>`.
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
An answered item leaves `decided` when its task closes.

Run `orc backlog thread <task-id>` to see one task's items alongside its holds, questions, answers, and notes.
On a machine without a backlog, the JSON command prints an empty queue.

## Run the attention tool

To run the live attention panel, run `orc-dash panel attention`.
It runs alone in a plain terminal or in a Herdr pane.
The panel reads `orc attention --json` on the machine it runs on and nothing else, and paints again every 10 seconds.
The dashboard shows it by default, above the resources panel in a wide layout and second in the narrow glance, as [Lay out the dashboard](../dash-dashboard.md#lay-out-the-dashboard) shows.
It shows each open item oldest first, with its task, its owner, its age and its kind, and its text below.
An overdue item starts with `!` and says `overdue` after its age.
The head counts the open items and the overdue ones.
With no open item, it says `nothing needs anyone`.
Without `orc` on the `PATH`, it says `orc` is not installed.
To print one frame of plain text instead, run `orc-dash panel attention --print`.
