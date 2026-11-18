---
kind: reference
---
# The attention queue
Everything that waits on someone is one item in one queue, kept beside the backlog in `~/.orc/backlog/attention`.
Each item is one JSON file with its `kind`, its `task`, its `text`, the time it was `asked`, its `owner` and its `state`.
The owner names who must answer it, `decider` or `user`.
The state starts as `open`.
An answer makes it `closed`, and a closed item keeps the answer words and time.
A review question, a worker question or an overdue wait turns `withdrawn` with its reason and time when its task closes or when it is no longer asked.
A review question, a worker question or an overdue wait that a beat reads as still asked opens again, with its current text, and a question keeps the owner and decision it had.
An answer to that item closes it with the answer words and time.
Showing an item never closes it.
An open item is overdue once more than 5 minutes have passed since it was asked.

A review question a run asks is an item of kind `review-question`, owned by the decider.
A question Pi asks mid-run with `orc_ask` is an item of kind `worker-question`, owned by the decider, as [A worker question](parked-runs.md#a-worker-question) shows.
Its item carries the question's `options` when Pi gave any, each with its `text` and an optional `picture`.
The `looping` question a run asks when Pi fails one command 6 times in a row is owned by you, as [A looping run](parked-runs.md#a-looping-run) shows.
A running run whose Pi has failed one command 3 times in a row opens an item of kind `failing-command` for you, which only tells you.
It is withdrawn once a beat reads the run with that command no longer failing, or the run ends.
The beat that writes the question into the task's `parked_questions`, as [Parked runs](parked-runs.md) shows, opens its item.

## The decider
The same beat hands each open item the decider owns to the decider, one short Pi call per question.
The call runs on `models.decider` in `config.json`, as [Configuring providers](configuring-providers.md) shows, with no tools.
Its system prompt is the written policy in `packages/run/agents/decider-policy.md`.
Its prompt holds the rules it reads, each under a label that names its file, then the task’s title and body, which hold its intent, then the earlier answers and asked-back questions of that task when any exist, then the question.
The rules are your rules in `<ORC_HOME>/orchestrator.md` and the instructions file of the task's project in `projects.json`, each when it exists.

Some questions never reach the decider.
Before the call, orc checks the question's words against a fixed list of topics: deleting, security, keys or credentials, merging, pushing, releasing, spending, anything that cannot be undone, a site's look, legal text, and logins.
Deleting matches delete, remove, drop, erase, wipe, purge, destroy and rm.
A site's look matches look, appearance, visual, screenshot and preview.
Legal text matches legal, law, privacy policy, terms of use, consent and offer.
Logins match login, log in, sign in, auth, authentication, authorization and oauth.
A question on that list goes to you, and its `decision` is `escalated` with the topic and the word that matched as its reason.
The list is in the code, so neither your rules nor the policy can widen what the decider answers.

The decider takes one of four actions, and the item keeps it as a `decision` with its time:

- **answer**: the reply names the answer, the reason and the `rule` it rests on, quoted word for word from your rules, the project's instructions, the policy or the task's body.
  Orc escalates an answer whose quote is no whole sentence or line of them, after whitespace is collapsed and surrounding quotes and a leading list or quote marker are stripped on both sides.
  A quote matches a whole line, a sentence within a line, a whole paragraph joined across its lines, or a sentence of that joined paragraph.
  The answer goes to the task as `orc backlog answer` would give it, so the item closes with the answer's words.
  The `decision` is `answered` with the reason and the `rule`, which holds the `quote` and the `source` file it came from.
- **ask back**: for a `worker-question`, the decider may put one question to the worker instead of answering.
  The worker gets that question as the result of its `orc_ask` call, and the item stays open.
  A follow-up worker question carries the earlier asked-back question and the decider's question back in its prompt, and settling the follow-up closes the earlier asked-back item.
  The `decision` is `asked-back` with the decider's `question`.
  An ask back on a `review-question` escalates, because the run that asked it has stopped.
- **link a duplicate**: the decider may name an earlier answered question of the same task by its item id.
  Orc checks that the earlier item exists and has an answer, gives that answer, and records the `decision` as `duplicate` with the earlier item's id in `of`.
  A link to an item that does not exist or has no answer escalates.
- **escalate**: the item goes to you and stays open, and the `decision` is `escalated` with the decider's reason as its note to you.

A reply orc cannot read, a call that fails, a missing `models.decider` or a rules file orc cannot read escalates the item with that as its reason.

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
  On a yolo project, the item names each change that waits for your merge word, such as a workflow file change.
  A red check or a new commit withdraws it.
  Merging the PR closes it with the answer `merged`.
  Closing the PR without merging closes it with the answer `closed without merging`.

To answer one of these, run `orc attention answer <item-id> <words>`.
It refuses a review question, a worker question or an overdue wait and names the task to answer with `orc backlog answer` instead.

A held task whose `--until` date has passed opens an `overdue-wait` item, owned by the user and asked at the start of the next day on the machine local clock.
Answering the hold closes the item with the hold's answer.

Each beat reads the queue before it starts a new task, and prints one `needs the <owner> <item-id>: <text>` line per open item, oldest first, with `, overdue` after the owner for an overdue one.

## Seeing the queue
To see every open item, oldest first, run `orc attention`.
It prints each item's id, kind, task, owner, age and text, and marks an overdue one `overdue`.
It then prints each item the decider answered under a `Decided:` heading as `answered <id>: <words> (<reason>)`.
The reason of an answer on a rule ends with `, quoting <source>: "<quote>"`, and a duplicate shows `the same question as <item-id>`.
An answer you replaced shows `(the captain replaced the decider's answer "<words>")`.
An open item the decider asked back shows `(asked the worker back: <question>)` after its text.
An item the decider escalated carries its `decision` in `items`.
An item the decider answered stays visible under `decided` with its answer and its `decision` in the JSON.
An answered item leaves `decided` once its task closes.
With no open item it prints `nothing needs anyone`.
To print the same facts as JSON, run `orc attention --json`, whose document names its version first as `orc.attention.v1`:

```json
{
  "schema": "orc.attention.v1",
  "at": "2026-11-02T10:10:00.000Z",
  "items": [
    { "id": "orc-1.r2.2026-11-02T10_00_00_000Z", "kind": "review-question", "task": "orc-1", "text": "Keep the old flag?", "asked": "2026-11-02T10:00:00.000Z", "owner": "decider", "ageSeconds": 600, "overdue": true }
  ],
  "decided": [
    { "id": "orc-1.r3.2026-11-02T09_50_00_000Z", "kind": "review-question", "task": "orc-1", "text": "Keep the old flag?", "asked": "2026-11-02T09:50:00.000Z", "owner": "decider", "decision": { "kind": "answered", "reason": "the intent keeps the old flag", "rule": { "quote": "Keep the old flag for one release.", "source": "task orc-1" }, "at": "2026-11-02T10:00:00.000Z" }, "answer": { "words": "Keep it", "at": "2026-11-02T10:00:00.000Z" } }
  ]
}
```

`at` is the time the queue was read, and each item's age and overdue flag are taken at that time.
To watch the open items in a terminal, run `orc-dash panel attention`, as [orc-dash](../dash.md#run-the-attention-tool) shows.
On a machine with no backlog folder, `orc attention` prints `no backlog at <path>`, and `orc attention --json` prints an empty queue.

The queue holds every task's items.
To see one task's items in order with its holds, questions, answers and notes, run `orc backlog thread <task-id>`, the per-task view [Backlog and beat](backlog-and-beat.md) describes.
