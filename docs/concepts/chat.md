---
aside: false
pageClass: wide-page part-chat
kind: explanation
---
# The chat

`orc chat` is the front door: you say the work in plain words, and it turns your words into backlog commands.
The chat is a Pi session with seventeen tools and no others, so it can change the backlog and nothing else.

![The chat: your words in, backlog commands out](../diagrams/chat.svg)

## What the chat can do

Each tool runs one `orc` command, the same one you could type.

| Tool | What it does |
| --- | --- |
| `orc_backlog_add` | Adds one task, with its kind, machine, parent, dependencies and priority |
| `orc_backlog` | Reads the backlog, with every project, machine and task |
| `orc_backlog_hold` | Holds a new task for your decision, with a reason and questions |
| `orc_backlog_priority` | Sets or clears a new task's priority |
| `orc_machines` | Reads the orc version each dispatch machine runs |
| `orc_backlog_stop` | Kills a started task's run and closes the task stopped |
| `orc_backlog_drop` | Closes a new task as dropped, with a reason |
| `orc_backlog_send_back` | Sends a closed task's open pull request back with your review |
| `orc_backlog_note` | Leaves a note on a task |
| `orc_backlog_depend` | Replaces or clears the tasks a new or held task waits for |
| `orc_backlog_thread` | Reads a task's conversation, oldest first |
| `orc_backlog_edit` | Replaces the title and the body of a new task |
| `orc_backlog_answer` | Answers a held task, a parked task, a decision or a run waiting at its gate |
| `orc_attention` | Reads the attention queue through `orc attention --json` |
| `orc_attention_answer` | Answers a `check-red`, `run-died`, `machine-unreached`, or `pr-ready` item through `orc attention answer` |
| `merge_task` | Lands a closed task's pull request through `orc merge` |
| `orc_decision_board` | Opens a local page with one card per open question |

The chat starts nothing itself.
The beat starts the tasks, and a task the chat adds waits until it has a priority.

## What the chat tells you

While it runs, the chat reads `orc backlog --json` every 15 seconds and posts what changed.

- Each task that closed, with its outcome, its reason and its pull request or report.
- Each held task and each parked question that waits on you.
- Each event the beat recorded: a stalled run, a pull request that turned green, merged or closed, and a split.
- Each alert the dashboard's alert stream fired.

Orc marks each close as posted in the task file.
So a task that closed while no chat ran is posted by the next chat to start.

## Your rules

When `~/.orc/orchestrator.md` exists, the chat adds it to its system prompt as your rules.
It also adds the instructions file of each project that names one.
The decider reads the same files, so one set of rules steers both.

## Decision boards

For a task with several open questions, the chat can open a decision board.
The board is a local web page with one card per question, each with its options and the one the chat recommends.
Each card you answer is recorded through `orc backlog answer`, word for word.
The page has no login, so anyone on your network who holds the link can answer as you.

## Related topics

- [The attention queue](attention.md)
- [The backlog](backlog.md)
- [Adding tasks from a chat](../run/chat.md)
- [Run a backlog from the chat](../tasks/run-a-backlog.md)
