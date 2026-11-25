---
kind: reference
---
# Adding tasks from a chat

Run `orc chat` to add and manage tasks in a Pi session.
The chat uses `models.orchestrator` from `config.json` and refuses to start if no model is set.

## Session and instructions

Use `orc chat --session <file>` to choose a session file.
Orc passes its absolute path to Pi.
If the file exists, Pi resumes it.
Otherwise, Pi creates it after the first reply.

When present, `<ORC_HOME>/orchestrator.md` supplies the orchestrator's system instructions.
The chat also loads each instructions file named in `projects.json`, labelled by project.
Its first output line lists the loaded files or says that no orchestrator rules were found.
The same orchestrator rules and the task project's instructions also go to [the decider](attention-queue.md#the-decider).

## Chat tools

The chat gives Pi these tools:

| Tool | Action |
| --- | --- |
| `orc_backlog_add` | Add a task with a project and Markdown body. Decisions have no priority or machine. |
| `orc_backlog` | Read projects, machines, tasks, and their states. |
| `orc_backlog_hold` | Hold a new task other than a decision, with a reason, date, or questions. |
| `orc_backlog_priority` | Set or clear a new task's priority from 0 to 4. |
| `orc_machines` | Read the orc version each dispatch machine runs, through `orc machines --json`. |
| `orc_backlog_stop` | Kill a started task's run and close the task stopped. |
| `orc_backlog_drop` | Close a new task as dropped, with a reason. |
| `orc_backlog_send_back` | Send a closed task's open PR back with your review. |
| `orc_backlog_note` | Leave a note on a task. |
| `orc_backlog_depend` | Replace or clear the tasks a new or held task waits for. |
| `orc_backlog_thread` | Read a task's conversation, oldest first. |
| `orc_backlog_edit` | Replace a new task's title and body without losing its hold or dependencies. |
| `orc_backlog_answer` | Answer a hold, parked question, decision, or gate. |
| `orc_attention` | Read the attention queue. |
| `orc_attention_answer` | Answer a `check-red`, `run-died`, `machine-unreached`, or `pr-ready` item. |
| `merge_task` | [Merge a closed task's PR](merging-a-tasks-pr.md). |
| `orc_decision_board` | Open a board for a task waiting on you. |

A configured planner can split an over-budget ship task at intake.
See [Splitting at intake](task-kinds.md#splitting-at-intake).

## Backlog updates

A task without a priority waits until you set one with `orc backlog priority <task-id> <0-4>`.
The chat polls the backlog every 15 seconds and posts closed tasks, events, and alerts when Pi is idle.
It marks posted closes and events so a later chat can report what happened while no chat was running.
A close can repeat if a chat stops before marking it or two chats post at once.
When a read or mark fails, the chat reports the error and keeps polling.

## Questions for you

At startup the chat posts unanswered holds and parked questions that need your answer.
It also posts new parked questions and questions at a run's gate.
Questions assigned to the decider are not posted to you.
See [Parked runs](parked-runs.md) for run questions.

## Pi configuration

The chat loads your Pi settings and packages, including their providers.
It also uses the orchestrator provider's `env`, so the chat and that provider's runs use the same account regardless of shell exports.
The tools receive `ORC_HOME` from the shell running `orc chat`.

## Decision boards

`orc_decision_board` opens a board for a held or parked task, or a started task waiting at its gate.
It writes `<ORC_HOME>/boards/<task-id>/board.html`, with a card for each open question and its options and recommended answer.
A hold with a reason but no questions gets one card for the reason.

The board has no login.
Anyone on the same network with its link can submit answers that orc records as yours.
The chat opens it with `lavish-axi <board.html> --no-open --reopen` and posts a LAN URL.
The board is not published through `lavish-axi share`, a third-party host, or a public tunnel.
The page loads Tailwind and DaisyUI styles from the jsDelivr CDN.
The shell running `orc chat` must have `lavish-axi` on its `PATH`.

### Board address

Set `ORC_BOARD_HOST` to a hostname or IP address to choose the address.
Orc passes it as `LAVISH_AXI_HOST`, and Lavish binds that address and loopback and prints the session link.
Use `127.0.0.1` to keep the board on this machine.

Without `ORC_BOARD_HOST`, orc selects a private LAN IPv4 address, preferring 192.168.0.0/16, then 10.0.0.0/8, then 172.16.0.0/12.
It never selects the 100.64.0.0/10 tailnet range.
Without a LAN address, the board opens only on this machine.
If Lavish cannot bind the address, the chat includes its warning in the opened line.

### Answer a board

Each card answer is recorded through `orc backlog answer` with the option's exact text.
Any words you add follow the option after ` — `.
The chat and the board's Conversation panel show the recorded answer, and the card shows that it was recorded.
A task waits until all cards are answered.

Once the task no longer waits, the chat writes the answers to the page and ends the Lavish session.
Answers made outside the board are picked up at the next refresh in the same way.
An earlier board cannot answer a later board's cards.
At startup, the chat lists boards whose tasks still wait on you, with the opening time and outstanding questions.
Open one again with `orc_decision_board` to answer the rest.
