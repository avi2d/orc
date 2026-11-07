---
kind: reference
---
# Where things are in the run package

Each path below sits in the run package or the workspace tests that cover it.

| Path | What it holds |
| --- | --- |
| `packages/run/src/bin.ts` | The orc entry point |
| `packages/run/src/args.ts` | The flag parsing for the orc command |
| `packages/run/src/run.ts` | The `orc run` agent step: checkout checks, agent files and the Pi run in the selected sandbox |
| `packages/run/src/orc-config.ts` | The reading of `config.json`: the providers and the implementer, fixer and orchestrator models |
| `packages/run/src/chat.ts` | The `orc chat` start of Pi on the orchestrator model with the chat tools |
| `packages/run/src/chat-tools.ts` | The chat tools and the poll that posts each closed task and each event into the chat once |
| `packages/run/src/chat-parked.ts` | The chat's listing of parked questions, once per start and once per park |
| `packages/run/src/chat-board.ts` | The chat's decision boards: the cards, the answers they record and the listing at each start |
| `packages/run/src/chat-board-page.ts` | The decision board page and the record of its cards |
| `packages/run/src/chat-lavish.ts` | The `lavish-axi` launcher that opens, reads and ends a board's session |
| `packages/run/src/json-file.ts` | The JSON config file reading and its `ConfigError` |
| `packages/run/src/model-route.ts` | The choice of the configured provider for the agent models and the check of a token file |
| `packages/run/src/sandbox-plan.ts` | The per-provider preflight: the Pi login check, the model windows and the run's Pi folder |
| `packages/run/src/run-record.ts` | The terminal run report, its evidence files and the `report.md` write |
| `packages/run/src/run-folders.ts` | A run's folders, its task copies and the instructions file `--instructions` names |
| `packages/run/src/history-write.ts` | The history checkpoints a run records as each step starts and ends |
| `packages/run/src/report.ts` | The `report.md` shape and the signal facts it carries |
| `packages/run/src/show.ts` | The `orc show` reading of one run from the history |
| `packages/run/src/run-session.ts` | The reading of the Pi session from the host sessions folder |
| `packages/run/src/pi.ts` | The Pi agent command, its prompt and the check of its final reply |
| `packages/run/src/agents.ts` | The agent file parsing and lookup |
| `packages/run/src/context-mark.ts` | The 150 thousand token compaction mark orc writes into the run's Pi folder |
| `packages/run/agents` | The bundled agent files |
| `packages/run/src/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `packages/run/src/answer-wait.ts` | The wait at a no-mistakes gate for the captain's answers in the run folder |
| `packages/run/src/toon.ts` | The reading of the TOON output no-mistakes prints |
| `packages/run/src/run-history.ts` | The records home, the SQLite run history and `orc runs` |
| `packages/run/src/nono.ts` | The Sandcastle sandbox provider that runs each command in `nono run` |
| `packages/run/src/host.ts` | The host-side processes and tools the provider runs outside nono, and the guard on host git |
| `packages/run/src/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data and the Pi session folder, and routes the model credential |
| `packages/run/src/no-sandbox.ts` | The Sandcastle provider that runs Pi and the checks directly on the host |
| `packages/run/src/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |
| `packages/run/src/dispatch/backlog.ts` | The backlog folders, the id reservation and the atomic take of a task |
| `packages/run/src/dispatch/task-record.ts` | The task file and its frontmatter |
| `packages/run/src/dispatch/parked.ts` | Parking a run's task on its questions, and the answer to a hold or a question |
| `packages/run/src/dispatch/config.ts` | The reading of `dispatch.json` and `projects.json` |
| `packages/run/src/dispatch/quota.ts` | The quota reading from the configured command and the pick of an account |
| `packages/run/src/dispatch/beat.ts` | The beat: room, placement, take and start |
| `packages/run/src/dispatch/beat-action.ts` | The beat actions each beat step reports |
| `packages/run/src/dispatch/beat-close.ts` | The closing of finished runs and the running output time |
| `packages/run/src/dispatch/beat-place.ts` | The room reading and the placement of each new task |
| `packages/run/src/dispatch/load.ts` | The five minute load reading and the overloaded machines |
| `packages/run/src/dispatch/machine-reach.ts` | The sweep ownership check and the remote command prefix |
| `packages/run/src/dispatch/stall.ts` | The stalled run flag kept in the backlog logs |
| `packages/run/src/dispatch/events.ts` | The chat events under `events/`, their posted marks and the alert fires the backlog lists |
| `packages/run/src/dispatch/task-events.ts` | The stall and PR events the beat records for every task |
| `packages/run/src/dispatch/alert-events.ts` | The reading of each `alerts.jsonl` line as one alert fire |
| `packages/run/src/dispatch/alert-stream.ts` | The one alert stream `orc runner start` queues in pueue |
| `packages/run/src/dispatch/pr-view.ts` | The `gh pr view` reading of a task's PR and its check verdicts |
| `packages/run/src/dispatch/board.ts` | The terminal board and the `orc.backlog.v1` and `orc.beat.v1` JSON |
| `packages/run/src/dispatch/runner.ts` | The runner: the start and the token renewal through pueue |
| `packages/run/src/dispatch/runner-instructions.ts` | The project instructions a start carries to the machine that queues the run |
| `packages/run/src/dispatch/runner-error.ts` | The runner's error |
| `packages/run/src/dispatch/refresh.ts` | The fast-forward of the checkout's default branch when a run starts |
| `packages/run/src/dispatch/runner-result.ts` | The reading of a task's result and the `orc.runner.v1` JSON |
| `packages/run/src/dispatch/upstream.ts` | The beat's read of each project's upstream contributions and the scout task a change adds |
| `packages/run/src/dispatch/token.ts` | The `orc.token.v1` document, the token command and the clauth session reading |
| `packages/run/src/dispatch/held-token.ts` | The owner-only token folder a run on another machine reads |
| `packages/run/src/dispatch/hold.ts` | `orc runner hold`: the wait for a live token, the rerun and the folder removal |
| `packages/run/src/dispatch/pueue-status.ts` | The pueue status shapes and the held-task lookup the runner reads |
| `packages/run/src/dispatch/args.ts` | The flag parsing for `orc backlog`, `orc beat`, `orc runner` and `orc merge` |
| `packages/run/src/dispatch/cli.ts` | The `orc backlog`, `orc beat`, `orc runner` and `orc merge` commands |
| `packages/run/src/dispatch/merge.ts` | The `orc merge` guard and squash-merge |
| `packages/run/src/dispatch/merge-basis.ts` | The `captain-word` and `yolo-green` bases `orc merge` takes |
| `tests/unit` | The in-process unit tests at the workspace root |
| `tests/e2e` | The tests that run `packages/run/src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1`, at the workspace root |
| `tests/fixtures/runner/pueue` | The pueue 4 status JSON the runner tests read |
| `tests/live` | The tests that run a real nono sandbox with `ORC_NONO_E2E=1` set, or the host's Pi, through the `test:live` script at the workspace root |
| `.no-mistakes.yaml` | The check commands no-mistakes and CI run at the workspace root |
