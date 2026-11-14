---
kind: reference
---
# Where things are in the run package

Each path below sits in the run package or the workspace tests that cover it.

## app

| Path | What it holds |
| --- | --- |
| `packages/run/src/app/args.ts` | The flag parsing for the orc command |
| `packages/run/src/app/dispatch-args.ts` | The flag parsing for `orc backlog`, `orc beat`, `orc runner`, `orc merge` and `orc heavy` |
| `packages/run/src/app/dispatch-cli.ts` | The `orc backlog`, `orc beat`, `orc runner`, `orc merge` and `orc heavy` commands |
| `packages/run/src/app/dispatch-args-runner.ts` | The `orc runner` verb parsing and the shared `--json` flag and reach split |
| `packages/run/src/app/dispatch-args-heavy.ts` | The `orc heavy` verb parsing |
| `packages/run/src/app/help.ts` | The help pages: the overview, the per-command help, the usage error text and the closest-command suggestion |
| `packages/run/src/app/help-format.ts` | The help layout: wrapping to 80 columns, the usage block and the name and text tables |
| `packages/run/src/app/help-entries-run.ts` | The help entries for `orc run`, the run history commands, `orc chat` and `orc app` |
| `packages/run/src/app/help-entries-backlog.ts` | The help entries for `orc backlog` and its subcommands, `orc attention`, `orc beat` and `orc merge` |
| `packages/run/src/app/help-entries-runner.ts` | The help entries for `orc runner` and `orc heavy` and their subcommands |

## widgets/beat

| Path | What it holds |
| --- | --- |
| `packages/run/src/widgets/beat/quota.ts` | The quota reading from the configured command and the pick of an account |
| `packages/run/src/widgets/beat/beat.ts` | The beat: room, placement, take and start |
| `packages/run/src/widgets/beat/beat-close.ts` | The closing of finished runs and the running output time |
| `packages/run/src/widgets/beat/beat-place.ts` | The room reading, the placement of each new task and the wait it names |
| `packages/run/src/widgets/beat/beat-origin.ts` | The `orc backlog origin` write of a parked task's machine and run, and its refusals |
| `packages/run/src/widgets/beat/load.ts` | The five minute load reading and the overloaded machines |
| `packages/run/src/widgets/beat/stall.ts` | The stalled run flag kept in the backlog logs |
| `packages/run/src/widgets/beat/task-events.ts` | The stall and PR events the beat records for every task |
| `packages/run/src/widgets/beat/board.ts` | The terminal board and the `orc.backlog.v1` and `orc.beat.v1` JSON |
| `packages/run/src/widgets/beat/upstream.ts` | The beat’s read of each project’s upstream contributions and the scout task a change adds |
| `packages/run/src/widgets/beat/beat-attention.ts` | The beat attention pass: the actions it reports and queues and the questions the decider owns |

## features/attention-list

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/attention-list/attention-view.ts` | The `orc attention` table and its `orc.attention.v1` JSON |

## features/backlog-planning

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/backlog-planning/cli-add.ts` | The `orc backlog add` command and the intake split of an over budget request |
| `packages/run/src/features/backlog-planning/backlog-plan.ts` | The `orc backlog plan` view of a parent plan and the drop of a new child |
| `packages/run/src/features/backlog-planning/intake-plan.ts` | The planner model ask at intake and its five minute limit |
| `packages/run/src/features/backlog-planning/backlog-depend.ts` | The task dependency writes and the refusal when a wait would cycle |
| `packages/run/src/features/backlog-planning/backlog-hold.ts` | The task hold writes and the refusal when a task is already held |
| `packages/run/src/features/backlog-planning/backlog-drop.ts` | The `orc backlog drop` close of a new task as `dropped` and its refusals |
| `packages/run/src/features/backlog-planning/backlog-edit.ts` | The `orc backlog edit` rewrite of a new task's title and body |
| `packages/run/src/features/backlog-planning/backlog-priority.ts` | The task priority writes and the refusal when a task is taken, started or closed |

## features/task-thread

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/task-thread/note.ts` | The `orc backlog note` command and its refusal of a task id the backlog does not hold |
| `packages/run/src/features/task-thread/thread.ts` | The `orc backlog thread` view, built on each read from the task file, its attention items and its notes, and its `orc.thread.v1` JSON |

## features/chat

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/chat/chat.ts` | The `orc chat` start of Pi on the orchestrator model with the chat tools |
| `packages/run/src/features/chat/chat-tools.ts` | The chat tools and the poll that posts each closed task and each event into the chat once |
| `packages/run/src/features/chat/chat-parked.ts` | The chat's listing of parked questions, once per start and once per park |
| `packages/run/src/features/chat/chat-board.ts` | The chat's decision boards: the cards, the answers they record and the listing at each start |
| `packages/run/src/features/chat/chat-board-page.ts` | The decision board page and the record of its cards |
| `packages/run/src/features/chat/chat-lavish.ts` | The `lavish-axi` launcher that opens, reads and ends a board’s session |
| `packages/run/src/features/chat/chat-backlog.ts` | The chat view of the backlog: the open and closed task shapes and the held or parked decision a task waits on |
| `packages/run/src/features/chat/chat-board-bind.ts` | The binding of waiting decisions to board records and the words a finished card posts |
| `packages/run/src/features/chat/chat-closed.ts` | The closed task shape and the line the chat posts for it |
| `packages/run/src/features/chat/chat-command.ts` | The shell a chat tool runs through the shared Bun layers |
| `packages/run/src/features/chat/chat-error.ts` | The error a chat tool fails with |
| `packages/run/src/features/chat/chat-inputs.ts` | The chat tool input shapes for add, hold, edit, answer, board and merge |
| `packages/run/src/features/chat/chat-posts.ts` | The backlog read and the walk that delivers each closed task and event once |

## features/decider

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/decider/decider.ts` | The decider: one call per open review question it owns, and its answer or escalation recorded on the item |
| `packages/run/src/features/decider/decider-ask.ts` | The decider's call, Pi on `models.decider` with the policy as its system prompt and no tools |

## features/heavy-commands

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/heavy-commands/heavy-cli.ts` | The `orc heavy` path, check, watch and watch-once commands |
| `packages/run/src/features/heavy-commands/heavy-watch.ts` | The watchdog that reports stalled calls and queue slips |
| `packages/run/src/features/heavy-commands/heavy-watch-slip.ts` | The slip search that finds heavy tool processes outside a running heavy task |

## features/installing-the-app

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/installing-the-app/app-install.ts` | The `orc app install` copy of the built Herdr App mods, layout and keys merge |

## features/merging-a-pr

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/merging-a-pr/merge.ts` | The `orc merge` guard and squash-merge |

## features/queueing-a-task

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/queueing-a-task/alert-stream.ts` | The one alert stream `orc runner start` queues in pueue |
| `packages/run/src/features/queueing-a-task/runner.ts` | The runner: the start, the kill and the token renewal through pueue |
| `packages/run/src/features/queueing-a-task/runner-instructions.ts` | The project instructions a start carries to the machine that queues the run |
| `packages/run/src/features/queueing-a-task/runner-result.ts` | The reading of a task's result and the `orc.runner.v1` JSON |
| `packages/run/src/features/queueing-a-task/hold.ts` | `orc runner hold`: the wait for a live token, the rerun and the folder removal |
| `packages/run/src/features/queueing-a-task/cli-stop.ts` | The stop of a started task: the kill, the result read and the close as stopped |

## features/running-a-task

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/running-a-task/run.ts` | The `orc run` agent step: checkout checks, agent files and the Pi run in the selected sandbox |
| `packages/run/src/features/running-a-task/sandbox-plan.ts` | The per-provider preflight: the Pi login check, the model windows and the run's Pi folder |
| `packages/run/src/features/running-a-task/run-record.ts` | The terminal run report, its evidence files and the `report.md` write |
| `packages/run/src/features/running-a-task/run-exec.ts` | The sandbox a run opens, the install that prepares the copy and the steps that run in it |
| `packages/run/src/features/running-a-task/run-loop.ts` | The implement, check and fix steps of one run |
| `packages/run/src/features/running-a-task/run-resume.ts` | The prior run's session and passed steps a resume starts from |
| `packages/run/src/features/running-a-task/checks.ts` | The check commands `.no-mistakes.yaml` names and their run in the copy |
| `packages/run/src/features/running-a-task/run-folders.ts` | A run's folders, its copy of the task file and the instructions file `--instructions` names |
| `packages/run/src/features/running-a-task/history-write.ts` | The history checkpoints a run records as each step starts and ends |
| `packages/run/src/features/running-a-task/context-mark.ts` | The 150 thousand token compaction mark orc writes into the run’s Pi folder |
| `packages/run/src/features/running-a-task/report-run.ts` | The report run: the Pi run that writes a report file instead of opening a PR |
| `packages/run/src/features/running-a-task/run-deliverer.ts` | The deliverer a run takes: the direct PR opener or the no-mistakes runner |
| `packages/run/src/features/running-a-task/run-place.ts` | The machine name a run records, read from `ORC_RUN_MACHINE` |

## features/seeing-runs

| Path | What it holds |
| --- | --- |
| `packages/run/src/features/seeing-runs/show.ts` | The `orc show` reading of one run from the history |
| `packages/run/src/features/seeing-runs/run-history-view.ts` | The `orc runs` table and its `orc.runs.v1` JSON |
| `packages/run/src/features/seeing-runs/run-facts.ts` | The facts `orc runs --json` reads beside each run: its title, latest step and open questions |
| `packages/run/src/features/seeing-runs/step-log.ts` | The `orc log` reading of one step's output file |
| `packages/run/src/features/seeing-runs/run-scores.ts` | The `orc score` step score writes: the 1 to 5 check, the note and the unknown run and step errors |

## entities/agent

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/agent/pi.ts` | The Pi prompt and the check of its final reply |
| `packages/run/src/entities/agent/pi-run.ts` | The Pi process in JSON mode: its event lines, the agent log, the session file and the idle stop |
| `packages/run/src/entities/agent/agents.ts` | The agent file parsing and lookup |
| `packages/run/src/entities/agent/long-session.ts` | The long session watch: the turn and compaction counts, the handover note and the handover prompt |

## entities/attention

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/attention/beat-action.ts` | The beat actions each beat step reports |
| `packages/run/src/entities/attention/attention.ts` | The attention queue under `attention/`: one file per item, its open and close and withdraw, the items of one task, and the review questions, run events and overdue waits routed into it |

## entities/backlog

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/backlog/backlog.ts` | The backlog folders, the id reservation and the atomic take of a task |
| `packages/run/src/entities/backlog/task-record.ts` | The task file and its frontmatter |
| `packages/run/src/entities/backlog/task-dependency.ts` | The child counts and the waits on dependencies and merged siblings |
| `packages/run/src/entities/backlog/split.ts` | The `orc.split.v1` planner document and the parent with vertical slice children it applies |
| `packages/run/src/entities/backlog/backlog-write.ts` | The backlog file helpers: the error, the scratch publish, the folder paths and the file take |
| `packages/run/src/entities/backlog/runner-label.ts` | The task branch names, the run labels and the file keys the runner files use |
| `packages/run/src/entities/backlog/task-kind.ts` | The task kinds `ship`, `scout`, `task` and `parent`, the agent report file name and the run folder |
| `packages/run/src/entities/backlog/task-record-render.ts` | The task file rendering from a task record |
| `packages/run/src/entities/backlog/notes.ts` | The task notes under `notes/`: one `<task-id>.jsonl` file per task, each note one appended line with its time, writer and text |

## entities/events

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/events/events.ts` | The chat events under `events/`, their posted marks and the alert fires the backlog lists |
| `packages/run/src/entities/events/alert-events.ts` | The reading of each `alerts.jsonl` line as one alert fire |
| `packages/run/src/entities/events/chat-event.ts` | The chat event shape: its key, time and text |
| `packages/run/src/entities/events/pr-state.ts` | The PR state the beat records under `pr-state/`: its read and write |

## entities/heavy-queue

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/heavy-queue/heavy.ts` | The heavy settings, the stand in folder and the default heavy tool list |
| `packages/run/src/entities/heavy-queue/heavy-setup.ts` | The reading of the heavy settings and the writing of the stand in folder |
| `packages/run/src/entities/heavy-queue/heavy-standin.ts` | The three line stand in launchers that start the helper for each heavy tool |
| `packages/run/src/entities/heavy-queue/heavy-classify.ts` | The per tool decision of which calls queue and which targeted calls take priority |
| `packages/run/src/entities/heavy-queue/heavy-standin-main.ts` | The helper a stand in launcher starts by the real bun path, and the waiter a queued pueue task starts |
| `packages/run/src/entities/heavy-queue/heavy-standin-exec.ts` | The helper's run of a call: the classify probe, the real tool as a child, the through command and the queued call waiter |
| `packages/run/src/entities/heavy-queue/heavy-standin-runtime.ts` | The stand in runtime: the helper command, the real tool lookup, the bypass event, the plan of a call and the queue wait |
| `packages/run/src/entities/heavy-queue/heavy-process-tree.ts` | The process tree walk that finds a call inside a held slot or under the through command |
| `packages/run/src/entities/heavy-queue/heavy-pueue-task.ts` | The reading of pueue status and log JSON for the queue wait and the exit code |

## entities/parked-runs

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/parked-runs/parked.ts` | Parking a run's task on its questions, and the answer to a hold or a question |

## entities/pull-request

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/pull-request/pr-view.ts` | The `gh pr view` reading of a task's PR and its check verdicts |
| `packages/run/src/entities/pull-request/merge-basis.ts` | The `captain-word` and `yolo-green` bases `orc merge` takes |
| `packages/run/src/entities/pull-request/direct-pr.ts` | The direct PR opener: the push, the existing check and the create, and the opened or failed record |

## entities/review-gate

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/review-gate/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `packages/run/src/entities/review-gate/answer-wait.ts` | The wait at a no-mistakes gate for the captain’s answers in the run folder |
| `packages/run/src/entities/review-gate/no-mistakes-drive-log.ts` | The no-mistakes drive log: the run record it keeps and the ending it reports |
| `packages/run/src/entities/review-gate/no-mistakes-gate.ts` | The no-mistakes gate output parsing: the findings, the open questions, the gate answers and the respond arguments |

## entities/run-history

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/run-history/report.ts` | The `report.md` shape and the signal facts it carries |
| `packages/run/src/entities/run-history/run-history.ts` | The records home, the SQLite run history and `orc runs` |
| `packages/run/src/entities/run-history/gate-refusals.ts` | The gate and rule parse from a failed check’s output, the `refusal` history signals and `orc refusals` |
| `packages/run/src/entities/run-history/history-resume.ts` | The resume reads from the run history: the latest run for a branch, its steps, its check rounds and its fixes |

## entities/task-copy

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/task-copy/checkout.ts` | The checks on the checkout a run starts from: its git root, refused markers, uncommitted changes and branch name |
| `packages/run/src/entities/task-copy/worktree-excludes.ts` | The registered worktrees inside a checkout that its clean check leaves out |
| `packages/run/src/entities/task-copy/task-copy.ts` | The task copy under `$ORC_HOME/worktrees`, keyed by the project folder's name, a hash of its real path and the branch, its reuse and removal, and the agent's git identity |
| `packages/run/src/entities/task-copy/refresh.ts` | The fast-forward of the checkout's default branch when a run starts |

## entities/token

| Path | What it holds |
| --- | --- |
| `packages/run/src/entities/token/token.ts` | The `orc.token.v1` document, the token command and the Claude credentials reading |
| `packages/run/src/entities/token/held-token.ts` | The owner-only token folder a run on another machine reads |

## shared/config

| Path | What it holds |
| --- | --- |
| `packages/run/src/shared/config/orc-config.ts` | The reading of `config.json`: the providers, the heavy queue tuning and the implementer, fixer, orchestrator, planner and decider models |
| `packages/run/src/shared/config/json-file.ts` | The JSON config file reading and its `ConfigError` |
| `packages/run/src/shared/config/model-route.ts` | The choice of the configured provider for the agent models and the check of a token file |
| `packages/run/src/shared/config/dispatch-config.ts` | The reading of `dispatch.json` and `projects.json` |
| `packages/run/src/shared/config/machine-reach.ts` | The sweep ownership check and the remote command prefix |
| `packages/run/src/shared/config/delivery.ts` | The delivery modes and the run delivery a project and its tasks take |

## shared/lib

| Path | What it holds |
| --- | --- |
| `packages/run/src/shared/lib/run-session.ts` | The `OrcRunError` a run fails with |
| `packages/run/src/shared/lib/toon.ts` | The reading of the TOON output no-mistakes prints |
| `packages/run/src/shared/lib/table.ts` | The table formatter the runs and refusals listings share |
| `packages/run/src/shared/lib/run-id.ts` | The new run id from the timestamp and a random part |

## shared/process

| Path | What it holds |
| --- | --- |
| `packages/run/src/shared/process/git-run.ts` | The git calls orc makes on the host with the operator's git config hidden |
| `packages/run/src/shared/process/runner-error.ts` | The runner's error |
| `packages/run/src/shared/process/pueue-status.ts` | The pueue status shapes and the held-task lookup the runner reads |
| `packages/run/src/shared/process/runner-exec.ts` | The process running helpers: the quiet spawn, the output capture, the pueue call, the JSON reads and the group setup |

## shared/sandbox

| Path | What it holds |
| --- | --- |
| `packages/run/src/shared/sandbox/sandbox-kind.ts` | The sandbox kinds a run takes |
| `packages/run/src/shared/sandbox/nono.ts` | The nono sandbox environment, its roots and the `nono why` check of a rendered profile |
| `packages/run/src/shared/sandbox/nono-exec.ts` | The opening of the nono sandbox a run's commands go through: the runtimes, the shims and the checked profile |
| `packages/run/src/shared/sandbox/standin-dir.ts` | The stand in folder suffix nono strips from the host path |
| `packages/run/src/shared/sandbox/agent-exec.ts` | The one way a run starts Pi and the checks, in `nono run` or on the host, with the environment built from an allow list |
| `packages/run/src/shared/sandbox/host.ts` | The host-side processes and tools orc runs outside nono, and the guard on host git |
| `packages/run/src/shared/sandbox/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data, the Pi session folder and the run's `sessions` folder, and routes the model credential |
| `packages/run/src/shared/sandbox/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |

## Entry point

| Path | What it holds |
| --- | --- |
| `packages/run/src/bin.ts` | The orc entry point |

## Package files

| Path | What it holds |
| --- | --- |
| `packages/run/agents` | The bundled agent files |
| `packages/run/agents/decider-policy.md` | The written policy the decider answers under |

## Tests and workspace

| Path | What it holds |
| --- | --- |
| `tests/unit` | The in-process unit tests at the workspace root |
| `tests/e2e` | The tests that run `packages/run/src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1`, at the workspace root |
| `tests/fixtures/runner/pueue` | The pueue 4 status JSON the runner tests read |
| `tests/live` | The tests that run a real nono sandbox with `ORC_NONO_E2E=1` set, or the host's Pi, through the `test:live` script at the workspace root |
| `.no-mistakes.yaml` | The check commands no-mistakes and CI run at the workspace root |
