---
kind: reference
---
# The heavy queue
Each machine queues its heavy shell calls through one pueue group named `heavy` with one slot.
Heavy calls are test runs, builds and browser runs through tools like `bun`, `bunx`, `npm`, `npx`, `pnpm`, `yarn`, `vitest`, `playwright`, `jest`, `go`, `cargo`, `pytest`, `tsc`, `oxlint`, `eslint`, `xcodebuild` and `xcrun`.
The queue keeps two such calls from overloading the machine at the same time.

## How calls reach the queue
`orc run` and `orc runner start` write stand in scripts for each heavy tool into `~/.orc/heavy/bin`.
`orc run` puts that folder first on `PATH` for the agent it starts.
A stand in queues the call with `pueue add` into the `heavy` group and waits for its turn, then prints the call output and exits with its exit code.
The wait message names how many queued calls stand ahead, counting higher priority calls and earlier calls at the same priority.
A finished call leaves the queue after the stand in reads its exit code.
The stand in runs the real tool under a utility priority on macOS and with no wrapper on other systems.
A call started by a queued call runs at once instead of queuing again.
The stand in trusts the process tree above the call, never an exported group variable on its own.
Set `HEAVY_QUEUE_BYPASS` to a reason to skip the queue for one command, and the reason is logged to the alerts file and counted by the check command.
Under `GITHUB_ACTIONS` a queued call waits up to 30 minutes, then fails with the queue length in its message.

## Targeted runs first
A targeted test run queues with priority, so a single file check runs ahead of whole suite runs.
A run counts as targeted when it names a test filter flag, a test file or a package path.
A bare word counts as a named file for `bun test`, `vitest` and `jest`.
A `watch`, `ui` or `dev` script never queues.
Whole suite runs queue with no priority and wait their turn.

## Check the queue
Run `orc heavy path` to create the stand ins and print the folder.
Run `orc heavy check` to read slots, running calls, queued calls with their ages, and bypasses.
Run `orc heavy check --json` for the same report as JSON.
Run `orc heavy watch` to arm the watchdog that reports stalled calls and queue slips.
Run `orc heavy watch-once` to run one watchdog pass and print its counts.

## Tune the queue
The `heavy` key in `~/.orc/config.json` tunes the queue.
The `group` key renames the pueue group.
The `commands` key adds command words that count as heavy, including subcommands of the built in tools.
The `limit` key takes `auto` or `none`, and `none` runs the real tool with no priority wrapper.

## Sandboxed runs
Sandboxed runs do not use the heavy queue yet.

## Watch the queue
`orc runner start` arms the watchdog beside the alert stream.
The watchdog reports only the local machine.
A running targeted call older than 10 minutes writes a `long-task` alert, once per machine per 10 minutes.
A heavy tool process outside a running `heavy` task writes a `heavy-slip` alert naming the command, once per command per 10 minutes.
