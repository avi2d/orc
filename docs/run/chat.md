---
kind: reference
---
# Adding tasks from a chat
To say tasks in a chat instead of writing task files, run `orc chat`.
It starts Pi on the model `models.orchestrator` names in `config.json`, and refuses to start when it names none.
When `<ORC_HOME>/orchestrator.md` exists, the chat adds it to Pi's system prompt as the orchestrator's rules.
It also adds the instructions file of each project in `projects.json` that names one, labelled with the project's name.
Its first line of output names the rules file it loaded, or says it found none, and then names each instructions file.
The chat's Pi has six tools and no others:

- `orc_backlog_add` adds one task through `orc backlog add <project> -`, with the project and the task's Markdown.
  It may add a kind, an internal mark, a machine and the ids the task depends on.
- `orc_backlog` reads `orc backlog --json`, so the chat knows the projects, the machines and each task's state and PR.
- `orc_backlog_hold` holds one new task through `orc backlog hold`, with the reason, an optional date and optional questions.
- `orc_backlog_answer` answers a held task, a parked task, or a started task waiting at its gate through `orc backlog answer`, with your words as you said them, or one open question on such a task when it names the question's id.
- `merge_task` lands a closed task's PR through `orc merge <task-id> --basis <basis>`, as [Merging a task's PR](merging-a-tasks-pr.md) shows.
- `orc_decision_board` opens a decision board for one held task, one parked task, or one started task waiting at its gate, as [Decision boards](chat.md#decision-boards) shows.

So a task from the chat enters the backlog the way any other does, and the beat starts it.
When it starts and every 15 seconds after, the chat reads `orc backlog --json`.
While Pi is idle, it posts each closed task that has no `postedAt`, with its outcome, its reason and its PR or report, as in `orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7`.
It posts a task whoever added it: this chat, an earlier chat or the command line.
It posts each close then runs `orc backlog posted <task-id>`, which writes `posted_at` into the closed task file, so a task closed while no chat ran is posted by the next chat to start, and every close is posted, with a close repeated at most when the chat stops between its post and its mark, or when two chats post the same close in the same moment.
It posts each event the same way, then runs `orc backlog posted <event-key>`.
The beat records an event when a task's run stalls, or when a closed task's PR turns green, merges or closes without merging.
Each event file under `events/` is named for the event, so a beat records it once.
A second stall of one task is a new event.
`orc backlog --json` also lists each alert fire from `alerts.jsonl` in the backlog folder, and the chat posts each fire once.
The alert stream that `orc runner start` queues writes that file, as [The runner](runner.md) shows.
When it cannot read or mark the backlog, it posts orc's error once Pi is idle and keeps polling.
Each time the chat starts, it posts one line per held task you have not answered, once Pi is idle, as in `orc-2 Pick the API is held for the captain: REST or gRPC, until 2026-12-01`.
It posts one line per parked question you have not answered each time it starts, and once more when a task parks while it runs, as in `orc-3 Fix the retries is parked on orc/orc-3 for the captain's answer to question-4: Which retries are allowed?`.
Questions from a run waiting at its gate post the same way, as [Parked runs](parked-runs.md) shows.
A question whose line a failed read or a busy Pi kept back is posted on a later poll.
The chat's Pi loads your Pi settings and packages, so a provider a package adds works as it does in your Pi.
The chat's Pi also takes the `env` of the orchestrator's provider, so the chat and the runs of that provider use the same account whatever your shell exports.
`ORC_HOME` reaches the tools from the shell that runs `orc chat`.

## Decision boards

`orc_decision_board` writes one card per open question on a held task, a parked task, or a started task waiting at its gate into `<ORC_HOME>/boards/<task-id>/board.html`.
Each card has its options and the option the chat recommends.
A task held with a reason and no questions gets one card for the reason.
The chat opens the page with `lavish-axi <board.html> --no-open --reopen` and posts its URL on this machine's LAN address, so another device on the same Wi-Fi opens it from the link.
Anyone on the same network who holds the link can open the board and submit answers, which orc records as the captain's, because the page has no login.
The board is never published through `lavish-axi share`, a third-party host, or a public tunnel.
To name the address the board binds, set `ORC_BOARD_HOST` to a hostname or IP address.
Orc passes it to `lavish-axi` as `LAVISH_AXI_HOST`, which binds that address plus loopback and prints the session link on it.
An unset `ORC_BOARD_HOST` binds this machine's private LAN IPv4 address, preferring 192.168.0.0/16, then 10.0.0.0/8, then 172.16.0.0/12, and never the 100.64.0.0/10 tailnet range, and `127.0.0.1` keeps boards on this machine.
When no LAN address exists and the setting is unset, the board opens only on this machine.
When `lavish-axi` reports the address could not be bound, the chat passes its warning on in the opened line.
The page loads the Tailwind and DaisyUI styles Lavish recommends from the jsDelivr CDN.
Each card you answer is recorded through `orc backlog answer`, word for word as the option reads.
Words you add on the card follow the option after ` — `, as you wrote them.
The chat and the board's Conversation panel both show what orc recorded.
The page then shows that card as recorded, and the task stays waiting on you until every card has an answer.
Once the task no longer waits on you, the chat writes the recorded answers into the page and ends the board's Lavish session.
Answers recorded outside the board are picked up on the next refresh, which writes the page and ends the session the same way.
An answer sent from an earlier board records nothing, since each board answers only its own cards.
Each time the chat starts, it posts one line per board whose task still waits on you.
The line names the time the board opened and the questions it waits on.
Open the board again with `orc_decision_board` to answer the rest, which reads only a board opened that way.
The boards need `lavish-axi` on the PATH of the shell that runs `orc chat`.
