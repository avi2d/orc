---
kind: reference
---
# How orc runs Pi
Orc runs only Pi, and it starts Pi itself as `pi -p --mode json` in the task copy, inside `nono run` by default or on the host with `--sandbox none`.

- Orc passes the agent file's model, thinking level and tools, and the run's `sessions` folder as `--session-dir`.
- Orc writes the prompt to Pi’s standard input, and the prompt asks the agent to print `ORC_COMPLETE` on its own line once the work is committed.
- The prompt also asks the agent to print `ORC_SPLIT` on its own line and then a JSON document when the change outgrows the budget.
- Pi prints one JSON event per line, and its first line is the `session` header with the session id and timestamp.
- On that header orc records the session file, named after the timestamp and the id with `.jsonl`, so `orc show` names it while the step runs.
- Orc writes each assistant message to the step's log on its own line, and each command a tool starts on a line opening with `>`.
  The implement step logs to `agent.log` in the run folder, and each fix to `fix-<n>.log`.
- While a tool runs, orc writes `orc: still running <command> (N min)` to that log each minute.
- Orc stops Pi only after the idle limit passes with no output and no tool running, so a quiet test command is never cut off.
- Orc counts the step complete only when the session’s final assistant message stopped with `stop` and holds `ORC_COMPLETE` on its own line.
- A valid `ORC_SPLIT` proposal records the run as failed without running checks or opening a PR.
- The beat then turns the task into a parent and starts its children.
- When the task has a parent, its children join that parent instead, as [A worker split proposal](task-kinds.md#a-worker-split-proposal) shows.
- On resume orc passes the recorded session file as `--session`, and Pi continues that session instead of starting a new one.
- Orc sums the `usage` input and output counts each session message carries into the run's token totals.

`packages/run/src/entities/agent/pi-run.ts` starts Pi and reads its lines, `packages/run/src/entities/agent/pi.ts` checks the final reply, and `packages/run/src/run-loop.ts` reads the session after each step.
