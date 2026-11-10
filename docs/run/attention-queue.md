---
kind: reference
---
# The attention queue
Everything that waits on someone is one item in one queue, kept beside the backlog in `~/.orc/backlog/attention`.
Each item is one JSON file with its `kind`, its `task`, its `text`, the time it was `asked`, its `owner` and its `state`.
The owner names who must answer it, `decider` or `user`.
The state starts as `open`.
An answer makes it `closed`, and a closed item keeps the answer words and time.
When its task closes, or its question is no longer asked, the item turns `withdrawn` with its reason and time.
Showing an item never closes it.
An open item is overdue once more than 5 minutes have passed since it was asked.

A review question a run asks is an item of kind `review-question`, owned by the user.
The beat that writes the question into the task's `parked_questions`, as [Parked runs](parked-runs.md) shows, opens its item.
Answering it with `orc backlog answer <task-id> <question-id>=<text>` closes the item.
A question asked again with the same words keeps its item.
A question asked again with different words opens a new item, and the old item is withdrawn.
An answered question asked again opens a new item, and the old item keeps its answer.

To see every open item, oldest first, run `orc attention`.
It prints each item's id, kind, task, owner, age and text, and marks an overdue one `overdue`.
With no open item it prints `nothing needs anyone`.
To print the same facts as JSON, run `orc attention --json`, whose document names its version first as `orc.attention.v1`:

```json
{
  "schema": "orc.attention.v1",
  "at": "2026-11-02T10:10:00.000Z",
  "items": [
    { "id": "orc-1.r2.2026-11-02T10_00_00_000Z", "kind": "review-question", "task": "orc-1", "text": "Keep the old flag?", "asked": "2026-11-02T10:00:00.000Z", "owner": "user", "ageSeconds": 600, "overdue": true }
  ]
}
```

`at` is the time the queue was read, and each item's age and overdue flag are taken at that time.
To watch the open items in a terminal, run `orc-dash panel attention`, as [orc-dash](../dash.md#run-the-attention-tool) shows.
On a machine with no backlog folder, `orc attention` prints `no backlog at <path>`, and `orc attention --json` prints an empty queue.
