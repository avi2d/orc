---
kind: reference
---
# The heavy queue
Each machine queues its heavy shell calls through one pueue group named `heavy` with one slot.
Heavy calls are test runs, builds and browser runs through tools like `bun`, `bunx`, `npm`, `npx`, `pnpm`, `yarn`, `go`, `cargo`, `vitest`, `playwright`, `xcodebuild` and `xcrun`.
The queue keeps two such calls from overloading the machine at the same time.

## How calls reach the queue
`orc run` and `orc runner start` write stand in scripts for each heavy tool into `~/.orc/heavy/bin`.
`orc run` puts that folder first on `PATH` for the agent it starts.
A stand in queues the call with `pueue add` into the `heavy` group and waits for its turn, then prints the call output and exits with its exit code.
The stand in runs the real tool under a utility priority on macOS and with no wrapper on other systems.
Calls already inside the `heavy` pueue group run at once instead of queuing again.
Set `HEAVY_QUEUE_BYPASS` to a reason to skip the queue for one command, and the reason is logged to the alerts file and counted by the check command.
Under `GITHUB_ACTIONS` a queued call waits up to 30 minutes, then fails with the queue length in its message.

## Targeted runs first
A targeted test run queues with priority, so a single file check runs ahead of whole suite runs.
A run counts as targeted when it names a test filter flag, a test file or a package path.
Whole suite runs queue with no priority and wait their turn.

## Check the queue
Run `orc heavy path` to create the stand ins and print the folder.
Run `orc heavy check` to read slots, running calls, queued calls with their ages, and bypasses.
Run `orc heavy check --json` for the same report as JSON.
Run `orc heavy watch` to arm the watchdog that warns about stale machines.
Run `orc heavy watch-once` to run one watchdog pass and print its counts.

## Tune the queue
The `heavy` key in `~/.orc/config.json` tunes the queue.
The `group` key renames the pueue group.
The `commands` key adds command words that count as heavy beyond the built in tool list.
The `limit` key takes `auto` or `none`, and `none` runs the real tool with no priority wrapper.

## Watch stale machines
`orc runner start` arms the watchdog beside the alert stream.
A machine counts as stale when it fires no watchdog alert for 10 minutes.
A running targeted call older than 10 minutes writes a `long-task` alert naming the local machine.
A heavy tool process with no pueue task behind it writes a `heavy-slip` alert naming the local machine and the command.
