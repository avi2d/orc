---
aside: false
pageClass: wide-page part-attention
kind: explanation
---
# The attention queue and the decider

Everything that waits on someone is one item in one queue, so you have a single place to look.
Each item names who must answer it, and a model called the decider takes the routine ones off your hands.

![The attention queue and the decider: who answers what](../diagrams/attention.svg)

## What opens an item

| Kind | What it is | Who owns it |
| --- | --- | --- |
| `review-question` | A question the review raised at its gate | The decider first |
| `worker-question` | A question Pi asked mid-run with `orc_ask` | The decider first |
| `looping` question | Pi failed one command 6 times in a row | You |
| `failing-command` | Pi failed one command 3 times in a row, which only tells you | You |
| `run-died` | A run failed or its start failed | You |
| `machine-unreached` | Orc has not reached a run's dispatch machine for 10 minutes | You |
| `check-red` | A check turned red on a closed task's pull request | You |
| `pr-ready` | Every check is green on a closed task's pull request | You |
| `overdue-wait` | A hold's date has passed | You |
| `update-failed` | The hourly Orc update on a dispatch machine failed | The decider when a retry can help, else you |

A gate finding whose action is not `auto-fix`, `no-op`, or `ask-user` stays with you, as [The attention queue](../run/attention-queue.md) shows.
An open item is overdue once more than 5 minutes have passed since it was asked.

## The decider

Each beat hands every open item the decider owns to the decider, one short model call per question, with no tools.
The decider reads your rules in `~/.orc/orchestrator.md`, the instructions file of the task's project, the task itself, and earlier answers.
It can quote a rule, the task or the Rules section of its policy, reuse an earlier answer, or ask the worker for more detail.
Anything else goes to you instead.

Some questions never reach the decider.
Orc checks each question's words against a fixed list of topics, and a question on that list goes straight to you.

- Deleting, and anything that cannot be undone.
- Security, keys or credentials, and logins.
- Merging, pushing and releasing.
- Going public.
- Spending.
- A site's look, and legal text.

The list is in the code, so no rule you write can widen what the decider answers.

The decider never has the last word.
To replace one of its answers, run `orc backlog answer <task-id> <question-id>=<text>`, and your answer stands.

## Answering

To see every open item, oldest first, run `orc attention`.
To answer a question a run asked, run `orc backlog answer <task-id> <question-id>=<text>`.
To answer a run event such as `pr-ready`, run `orc attention answer <item-id> <words>`.
The chat and the App show the same items and take the same answers.

## Related topics

- [The chat](chat.md)
- [Checks and review](checks-and-review.md)
- [The attention queue](../run/attention-queue.md)
- [Parked runs](../run/parked-runs.md)
