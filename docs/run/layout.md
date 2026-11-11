---
kind: reference
---
# Where things are in the run package

Each path below sits in the run package or the workspace tests that cover it.

| Path | What it holds |
| --- | --- |
| `packages/run/src/bin.ts` | The orc entry point |
| `packages/run/src/args.ts` | The flag parsing for the orc command |
| `packages/run/src/app-install.ts` | The `orc app install` copy of the built Herdr App mods, layout and keys merge |
| `packages/run/src/run.ts` | The `orc run` agent step: checkout checks, agent files and the Pi run in the selected sandbox |
| `packages/run/src/shared/config/orc-config.ts` | The reading of `config.json`: the providers, the heavy queue tuning and the implementer, fixer, orchestrator, planner and decider models |
| `packages/run/src/chat.ts` | The `orc chat` start of Pi on the orchestrator model with the chat tools |
| `packages/run/src/chat-tools.ts` | The chat tools and the poll that posts each closed task and each event into the chat once |
| `packages/run/src/chat-parked.ts` | The chat's listing of parked questions, once per start and once per park |
| `packages/run/src/chat-board.ts` | The chat's decision boards: the cards, the answers they record and the listing at each start |
| `packages/run/src/chat-board-page.ts` | The decision board page and the record of its cards |
| `packages/run/src/chat-lavish.ts` | The `lavish-axi` launcher that opens, reads and ends a board's session |
| `packages/run/src/shared/config/json-file.ts` | The JSON config file reading and its `ConfigError` |
| `packages/run/src/shared/config/model-route.ts` | The choice of the configured provider for the agent models and the check of a token file |
| `packages/run/src/sandbox-plan.ts` | The per-provider preflight: the Pi login check, the model windows and the run's Pi folder |
| `packages/run/src/sandbox-kind.ts` | The sandbox kinds a run takes |
| `packages/run/src/run-record.ts` | The terminal run report, its evidence files and the `report.md` write |
| `packages/run/src/checkout.ts` | The checks on the checkout a run starts from: its git root, refused markers, uncommitted changes and branch name |
| `packages/run/src/worktree-excludes.ts` | The registered worktrees inside a checkout that its clean check leaves out |
| `packages/run/src/task-copy.ts` | The task copy under `$ORC_HOME/worktrees`, keyed by the project folder's name, a hash of its real path and the branch, its reuse and removal, and the agent's git identity |
| `packages/run/src/run-exec.ts` | The sandbox a run opens, the install that prepares the copy and the steps that run in it |
| `packages/run/src/run-loop.ts` | The implement, check and fix steps of one run |
| `packages/run/src/run-resume.ts` | The prior run's session and passed steps a resume starts from |
| `packages/run/src/checks.ts` | The check commands `.no-mistakes.yaml` names and their run in the copy |
| `packages/run/src/git-run.ts` | The git calls orc makes on the host with the operator's git config hidden |
| `packages/run/src/run-folders.ts` | A run's folders, its copy of the task file and the instructions file `--instructions` names |
| `packages/run/src/history-write.ts` | The history checkpoints a run records as each step starts and ends |
| `packages/run/src/report.ts` | The `report.md` shape and the signal facts it carries |
| `packages/run/src/show.ts` | The `orc show` reading of one run from the history |
| `packages/run/src/shared/lib/run-session.ts` | The `OrcRunError` a run fails with |
| `packages/run/src/pi.ts` | The Pi prompt and the check of its final reply |
| `packages/run/src/pi-run.ts` | The Pi process in JSON mode: its event lines, the agent log, the session file and the idle stop |
| `packages/run/src/agents.ts` | The agent file parsing and lookup |
| `packages/run/src/context-mark.ts` | The 150 thousand token compaction mark orc writes into the run's Pi folder |
| `packages/run/agents` | The bundled agent files |
| `packages/run/src/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `packages/run/src/answer-wait.ts` | The wait at a no-mistakes gate for the captain's answers in the run folder |
| `packages/run/src/shared/lib/toon.ts` | The reading of the TOON output no-mistakes prints |
| `packages/run/src/run-history.ts` | The records home, the SQLite run history and `orc runs` |
| `packages/run/src/gate-refusals.ts` | The gate and rule parse from a failed check's output, the `refusal` history signals and `orc refusals` |
| `packages/run/src/shared/lib/table.ts` | The table formatter the runs and refusals listings share |
| `packages/run/src/nono.ts` | The nono sandbox environment, its roots and the `nono why` check of a rendered profile |
| `packages/run/src/nono-exec.ts` | The opening of the nono sandbox a run's commands go through: the runtimes, the shims and the checked profile |
| `packages/run/src/standin-dir.ts` | The stand in folder suffix nono strips from the host path |
| `packages/run/src/agent-exec.ts` | The one way a run starts Pi and the checks, in `nono run` or on the host, with the environment built from an allow list |
| `packages/run/src/host.ts` | The host-side processes and tools orc runs outside nono, and the guard on host git |
| `packages/run/src/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data, the Pi session folder and the run's `sessions` folder, and routes the model credential |
| `packages/run/src/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |
| `packages/run/src/dispatch/backlog.ts` | The backlog folders, the id reservation and the atomic take of a task |
| `packages/run/src/dispatch/task-record.ts` | The task file and its frontmatter |
| `packages/run/src/dispatch/parked.ts` | Parking a run's task on its questions, and the answer to a hold or a question |
| `packages/run/src/shared/config/dispatch-config.ts` | The reading of `dispatch.json` and `projects.json` |
| `packages/run/src/dispatch/quota.ts` | The quota reading from the configured command and the pick of an account |
| `packages/run/src/dispatch/beat.ts` | The beat: room, placement, take and start |
| `packages/run/src/dispatch/beat-action.ts` | The beat actions each beat step reports |
| `packages/run/src/dispatch/beat-close.ts` | The closing of finished runs and the running output time |
| `packages/run/src/dispatch/beat-place.ts` | The room reading, the placement of each new task and the wait it names |
| `packages/run/src/dispatch/load.ts` | The five minute load reading and the overloaded machines |
| `packages/run/src/shared/config/machine-reach.ts` | The sweep ownership check and the remote command prefix |
| `packages/run/src/dispatch/stall.ts` | The stalled run flag kept in the backlog logs |
| `packages/run/src/dispatch/attention.ts` | The attention queue under `attention/`: one file per item, its open and close and withdraw, and the review questions, run events and overdue waits routed into it |
| `packages/run/src/dispatch/attention-view.ts` | The `orc attention` table and its `orc.attention.v1` JSON |
| `packages/run/src/dispatch/decider.ts` | The decider: one call per open review question it owns, and its answer or escalation recorded on the item |
| `packages/run/src/dispatch/decider-ask.ts` | The decider's call, Pi on `models.decider` with the policy as its system prompt and no tools |
| `packages/run/agents/decider-policy.md` | The written policy the decider answers under |
| `packages/run/src/dispatch/events.ts` | The chat events under `events/`, their posted marks and the alert fires the backlog lists |
| `packages/run/src/dispatch/task-dependency.ts` | The child counts and the waits on dependencies and merged siblings |
| `packages/run/src/dispatch/task-events.ts` | The stall and PR events the beat records for every task |
| `packages/run/src/dispatch/alert-events.ts` | The reading of each `alerts.jsonl` line as one alert fire |
| `packages/run/src/dispatch/alert-stream.ts` | The one alert stream `orc runner start` queues in pueue |
| `packages/run/src/dispatch/pr-view.ts` | The `gh pr view` reading of a task's PR and its check verdicts |
| `packages/run/src/dispatch/board.ts` | The terminal board and the `orc.backlog.v1` and `orc.beat.v1` JSON |
| `packages/run/src/dispatch/runner.ts` | The runner: the start, the kill and the token renewal through pueue |
| `packages/run/src/dispatch/runner-instructions.ts` | The project instructions a start carries to the machine that queues the run |
| `packages/run/src/dispatch/runner-error.ts` | The runner's error |
| `packages/run/src/dispatch/refresh.ts` | The fast-forward of the checkout's default branch when a run starts |
| `packages/run/src/dispatch/runner-result.ts` | The reading of a task's result and the `orc.runner.v1` JSON |
| `packages/run/src/dispatch/upstream.ts` | The beat's read of each project's upstream contributions and the scout task a change adds |
| `packages/run/src/dispatch/token.ts` | The `orc.token.v1` document, the token command and the Claude credentials reading |
| `packages/run/src/dispatch/held-token.ts` | The owner-only token folder a run on another machine reads |
| `packages/run/src/dispatch/hold.ts` | `orc runner hold`: the wait for a live token, the rerun and the folder removal |
| `packages/run/src/dispatch/pueue-status.ts` | The pueue status shapes and the held-task lookup the runner reads |
| `packages/run/src/dispatch/args.ts` | The flag parsing for `orc backlog`, `orc beat`, `orc runner`, `orc merge` and `orc heavy` |
| `packages/run/src/dispatch/cli-add.ts` | The `orc backlog add` command and the intake split of an over budget request |
| `packages/run/src/dispatch/backlog-plan.ts` | The `orc backlog plan` view of a parent plan and the drop of a new child |
| `packages/run/src/dispatch/intake-plan.ts` | The planner model ask at intake and its five minute limit |
| `packages/run/src/dispatch/split.ts` | The `orc.split.v1` planner document and the parent with vertical slice children it applies |
| `packages/run/src/dispatch/cli.ts` | The `orc backlog`, `orc beat`, `orc runner`, `orc merge` and `orc heavy` commands |
| `packages/run/src/dispatch/merge.ts` | The `orc merge` guard and squash-merge |
| `packages/run/src/dispatch/merge-basis.ts` | The `captain-word` and `yolo-green` bases `orc merge` takes |
| `packages/run/src/dispatch/heavy.ts` | The heavy settings, the stand in folder and the default heavy tool list |
| `packages/run/src/dispatch/heavy-cli.ts` | The `orc heavy` path, check, watch and watch-once commands |
| `packages/run/src/dispatch/heavy-setup.ts` | The reading of the heavy settings and the writing of the stand in folder |
| `packages/run/src/dispatch/heavy-standin.ts` | The three line stand in launchers that start the helper for each heavy tool |
| `packages/run/src/dispatch/heavy-classify.ts` | The per tool decision of which calls queue and which targeted calls take priority |
| `packages/run/src/dispatch/heavy-standin-main.ts` | The helper a stand in launcher starts by the real bun path, and the waiter a queued pueue task starts |
| `packages/run/src/dispatch/heavy-standin-exec.ts` | The helper's run of a call: the classify probe, the real tool as a child, the through command and the queued call waiter |
| `packages/run/src/dispatch/heavy-standin-runtime.ts` | The stand in runtime: the helper command, the real tool lookup, the bypass event, the plan of a call and the queue wait |
| `packages/run/src/dispatch/heavy-process-tree.ts` | The process tree walk that finds a call inside a held slot or under the through command |
| `packages/run/src/dispatch/heavy-pueue-task.ts` | The reading of pueue status and log JSON for the queue wait and the exit code |
| `packages/run/src/dispatch/heavy-watch.ts` | The watchdog that reports stalled calls and queue slips |
| `packages/run/src/dispatch/heavy-watch-slip.ts` | The slip search that finds heavy tool processes outside a running heavy task |
| `tests/unit` | The in-process unit tests at the workspace root |
| `tests/e2e` | The tests that run `packages/run/src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1`, at the workspace root |
| `tests/fixtures/runner/pueue` | The pueue 4 status JSON the runner tests read |
| `tests/live` | The tests that run a real nono sandbox with `ORC_NONO_E2E=1` set, or the host's Pi, through the `test:live` script at the workspace root |
| `.no-mistakes.yaml` | The check commands no-mistakes and CI run at the workspace root |
