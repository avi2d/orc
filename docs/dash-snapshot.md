---
kind: reference
---
# Take a dashboard snapshot

The snapshot reads every source once and prints one JSON object.

## Take a snapshot

To read every source once and print one JSON object, run `orc-dash snapshot --json`.
To read only some sources, name them in `--only`, separated by commas, such as `orc-dash snapshot --json --only resources,tasks`.
The sources are `quota`, `resources`, `queues` and `tasks`, and a name that is none of them stops the command before it reads anything.
The sources read at the same time, and each has its own time limit.
A source that runs past its limit or breaks reports `failed` with its error, and the others still report.
The command exits 0 whenever it prints the snapshot, however many sources failed.
Each source reads the variables its tool reads, so a second machine configured for a tool shows in that source too.

| Source | What it holds | Limit |
| --- | --- | --- |
| `quota` | The composed session quota report, with every account's windows, their pace and gate, and the flags, merged with the second machine's report where `ORC_DASH_REMOTE_SESSION_QUOTA` is set | 3 minutes |
| `resources` | This machine's resources report, then the one `ORC_DASH_REMOTE_RESOURCES` prints | 30 seconds |
| `queues` | This machine's [pueue](https://github.com/Nukesor/pueue), then the one `ORC_DASH_REMOTE_PUEUE` prints, with the tasks that ended in the last day, and the [GitHub Actions](https://github.com/features/actions) runs that wait or run | 30 seconds |
| `tasks` | The tasks reports `ORC_DASH_TASKS` and `ORC_DASH_REMOTE_TASKS` print | 30 seconds |

The longest chain of commands a source runs ends inside its limit.
So a slow machine's reason lands in its reading, and the source still answers.
The quota source reads a week of agent logs and takes the longest, so leave it out of `--only` when only the machines matter.

## Read the Resources tab

To print the subscription rows that the [Herdr](https://herdr.dev) App reads, run `orc-dash report subscription-overview`.
To print machine resources and the number of running jobs in each machine's `orc` group, run `orc-dash report machine-overview`.
These commands omit session histories, completed jobs, and GitHub Actions runs.
The tab shows when it read each table and keeps the last rows visible during a refresh.

For example, set `ORC_DASH_REMOTE_SESSION_QUOTA="ssh other-host 'orc-dash report session-quota'"` and `ORC_DASH_REMOTE_PUEUE="ssh other-host 'pueue status --json'"`.
The overview commands ask that host for `report subscriptions` and `report running-orc`.
If the host lacks a report, the overview runs the configured command instead.
A custom command that does not use a recognized [SSH](https://www.openssh.com) form runs unchanged.

To measure the four App reads in a checkout, run `bun scripts/bench-app-reads.ts . overview example-42` with an ID from your backlog.
Use `snapshot` in place of `overview` for the older Resources commands.
Each line reports milliseconds to first output, milliseconds to exit, bytes, and a separate [Bun](https://bun.com) JSON parse time.
The measurement uses the checkout's CLI entry points, not the installed launcher or the App renderer.

## Read the snapshot

The snapshot is a version 1 JSON object with `generatedAt`, `machine`, and `sources`.
Each selected source is `ok` with its fields or `failed` with an error.
A source omitted by `--only` has no entry.
A configured machine can be `ok`, `unreachable`, or `invalid`.
An unset machine command has no entry.

The field definitions are in `SnapshotReport` in `packages/schema/src/features/snapshot/snapshot.ts`.
See the [resources report](dash-resources.md#read-the-resources-report), [tasks report](dash-tasks.md#read-the-tasks-report), and [composed quota report](session-quota/compose-two-machines.md#read-the-composed-report) for their contents.
