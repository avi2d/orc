---
kind: reference
---
# The heavy queue
Each machine queues its heavy shell calls through one pueue group named `heavy` with one slot.
Heavy calls are test runs, builds, installs and browser runs through tools like `bun`, `go`, `cargo`, `vitest`, `playwright`, `xcodebuild` and `xcrun`.
The queue keeps two such calls from overloading the machine at the same time.

## How calls reach the queue
`orc run` and `orc runner start` write stand in scripts for each heavy tool into `~/.orc/heavy/bin` and put that folder first on `PATH`.
A stand in queues the call with `pueue add` into the `heavy` group and waits for its turn, then runs the real tool under a utility priority on macOS.
Calls already inside a pueue worker run at once instead of queuing again.
Set `HEAVY_QUEUE_BYPASS` to a reason to skip the queue for one command, and the reason is logged to the alerts file and counted by the check command.
Under `GITHUB_ACTIONS` a queued call waits up to 30 minutes, then fails with the queue length in its message.

## Targeted runs first
A targeted test run queues with priority, so a single file check runs ahead of whole suite runs.
Whole suite runs queue with no priority and wait their turn.

## Check the queue
Run `orc heavy path` to create the stand ins and print the folder.
Run `orc heavy check` to read slots, running calls and queued calls with their ages.
Run `orc heavy check --json` for the same report as JSON.
Run `orc heavy watch` to arm the watchdog that warns about stale machines.
Run `orc heavy watch-once` to run one watchdog pass and print its counts.

## Tune the queue
The `heavy` key in `~/.orc/orc.json` tunes the queue.
The `group` key renames the pueue group.
The `commands` key adds command words that count as heavy beyond the built in tool list.
The `through` key lists command words that always run at once.
The `limit` key takes `auto` or `none`, and `none` runs the real tool with no priority wrapper.

## Watch stale machines
`orc runner start` arms the watchdog beside the alert stream.
A machine counts as stale when it fires no watchdog alert for 10 minutes.
A running heavy call older than 10 minutes that is not a whole suite run writes a `long-task` alert naming the stale machines.
