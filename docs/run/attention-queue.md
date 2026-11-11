---
kind: reference
---
# The attention queue
Everything that waits on someone is one item in one queue, kept beside the backlog in `~/.orc/backlog/attention`.
Each item is one JSON file with its `kind`, its `task`, its `text`, the time it was `asked`, its `owner` and its `state`.
The owner names who must answer it, `decider` or `user`.
The state starts as `open`.
An answer makes it `closed`, and a closed item keeps the answer words and time.
A review question or an overdue wait turns `withdrawn` with its reason and time when its task closes or when it is no longer asked.
Showing an item never closes it.
An open item is overdue once more than 5 minutes have passed since it was asked.

A review question a run asks is an item of kind `review-question`, owned by the decider.
The beat that writes the question into the task's `parked_questions`, as [Parked runs](parked-runs.md) shows, opens its item.

## The decider
The same beat hands each open item the decider owns to the decider, one short Pi call per question.
The call runs on `models.decider` in `config.json`, as [Configuring providers](configuring-providers.md) shows, with no tools.
Its system prompt is the written policy in `packages/run/agents/decider-policy.md`, and its prompt is the task's title and body, which hold its intent, and the question.
It answers a routine question, or escalates the question to the user.
Its answer goes to the task as `orc backlog answer` would give it, so the item closes with the answer's words.
An escalation hands the item to the user, and the item stays open.
Either way the item keeps a `decision` with `answered` or `escalated`, the decider's reason and its time, so `orc attention` shows the decider's answers afterwards.
A reply orc cannot read, a call that fails or a missing `models.decider` escalates the item with that as its reason.

## Answering an item
Answering a review question with `orc backlog answer <task-id> <question-id>=<text>` closes the item.
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

To answer one of these, run `orc attention answer <item-id> <words>`.
It refuses a review question or an overdue wait and names the task to answer with `orc backlog answer` instead.

A held task whose `--until` date has passed opens an `overdue-wait` item, owned by the user and asked at the start of the next day on the machine local clock.
Answering the hold closes the item with the hold's answer.

Each beat reads the queue before it starts a new task, and prints one `needs the <owner> <item-id>: <text>` line per open item, oldest first, with `, overdue` after the owner for an overdue one.

## Seeing the queue
To see every open item, oldest first, run `orc attention`.
It prints each item's id, kind, task, owner, age and text, and marks an overdue one `overdue`.
It then prints each item the decider answered under a `Decided:` heading as `answered <id>: <words> (<reason>)`.
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
    { "id": "orc-1.r3.2026-11-02T09_50_00_000Z", "kind": "review-question", "task": "orc-1", "text": "Keep the old flag?", "asked": "2026-11-02T09:50:00.000Z", "owner": "decider", "decision": { "kind": "answered", "reason": "the intent keeps the old flag", "at": "2026-11-02T10:00:00.000Z" }, "answer": { "words": "Keep it", "at": "2026-11-02T10:00:00.000Z" } }
  ]
}
```

`at` is the time the queue was read, and each item's age and overdue flag are taken at that time.
To watch the open items in a terminal, run `orc-dash panel attention`, as [orc-dash](../dash.md#run-the-attention-tool) shows.
On a machine with no backlog folder, `orc attention` prints `no backlog at <path>`, and `orc attention --json` prints an empty queue.
