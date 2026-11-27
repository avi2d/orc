---
kind: reference
---
# How orc runs Pi
Orc runs only [Pi](https://pi.dev), and it starts Pi itself as `pi -p --mode json` in the task copy.
A run you start by hand runs without a per-agent sandbox by default.
Pass `--sandbox nono` to run it under [`nono run`](https://nono.sh) instead.
Queued tasks always pass `--sandbox none` and run without a per-agent sandbox.
Their safety boundary is the isolated space around the whole agent system, as [Running without a sandbox](running-without-a-sandbox.md) describes.

## Pi sessions and output

- Orc passes the agent file's model, thinking level and tools, and the run's `sessions` folder as `--session-dir`.
- When `~/.pi/agent/extensions/tool-time-cap.ts` exists, orc passes it to Pi with `-e`, because a run's own Pi folder in `PI_CODING_AGENT_DIR` hides your `~/.pi/agent/extensions`.
  Orc passes it in the nono sandbox, where it adds the resolved file as a read-only grant, and on `--sandbox none` with a token file or package provider.
  Pi on a login provider without a sandbox loads it itself.
- Orc writes the prompt to Pi’s standard input, and the prompt asks the agent to print `ORC_COMPLETE` on its own line once the work is committed.
- The prompt also tells the agent to leave repository tests to [GitHub](https://github.com) CI, to run only `build`, `lint`, or `typecheck` locally, not to start or rerun CI by hand once a pull request run exists, not to wait for CI in a tool call, and to print `ORC_SPLIT` on its own line and then a JSON document when the change outgrows the budget.
- Pi prints one JSON event per line, and its first line is the `session` header with the session id and timestamp.
- On that header orc records the session file, named after the timestamp and the id with `.jsonl`, so `orc show` names it while the step runs.
- Orc writes each assistant message to the step's log on its own line, and each command a tool starts on a line opening with `>`.
  The implement step logs to `agent.log` in the run folder, each fix to `fix-<n>.log`, and reviews to `review-<n>.log`.
- While a tool runs, orc writes `orc: still running <command> (N min)` to that log each minute.
- Orc stops Pi only after the idle limit passes with no output and no tool running, so a quiet build, lint, or typecheck command is never cut off.

## Failed commands

Orc tracks one bash command that keeps failing.

- Orc counts each bash command whose `tool_execution_end` event carries `isError`, as a failure of that command.
  A success, or a failure of another command, starts the count over, and a tool other than bash leaves it as it is.
- At 3 failures of one command in a row orc logs `orc: pi failed <command> 3 times in a row` and writes `failing.json` to the run folder, with the command and the time.
  The beat opens an attention item for you on it, as [The attention queue](attention-queue.md) shows, and Pi carries on.
  Orc removes the file when the count starts over or Pi ends.
- At 6 failures of one command in a row orc logs `orc: stopped pi, it failed <command> 6 times in a row`, pauses the run and asks you to continue or stop, as [A looping run](parked-runs.md#a-looping-run) shows.

## Finish a step

A step can end on its completion marker, an idle timeout, or a failure.

- Orc counts the step complete only when the session’s final assistant message stopped with `stop` and holds `ORC_COMPLETE` on its own line.
- A valid `ORC_SPLIT` proposal records the run as failed without running checks or opening a PR.
- The beat then turns the task into a parent and starts its children.
- When the task has a parent, its children join that parent instead, as [A worker split proposal](task-kinds.md#a-worker-split-proposal) shows.
- Orc also loads its `orc_ask` extension into Pi with `--extension` and adds `orc_ask` to the tools, as [A worker question](parked-runs.md#a-worker-question) shows.
  Pi calls it to ask you a question mid-run instead of guessing or failing.
- On resume orc passes the recorded session file as `--session`, and Pi continues that session instead of starting a new one.
- Orc sums the `usage` input and output counts each session message carries into the run's token totals.

`packages/run/src/entities/agent/pi-run.ts` starts Pi and reads its lines, `packages/run/src/entities/agent/pi.ts` checks the final reply, and `packages/run/src/features/running-a-task/run-loop.ts` reads the session after each step.
