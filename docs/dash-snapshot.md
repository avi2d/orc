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
| `queues` | This machine's pueue, then the one `ORC_DASH_REMOTE_PUEUE` prints, and the GitHub Actions runs that wait or run | 30 seconds |
| `tasks` | The tasks reports `ORC_DASH_TASKS` and `ORC_DASH_REMOTE_TASKS` print | 30 seconds |

The longest chain of commands a source runs ends inside its limit.
So a slow machine's reason lands in its reading, and the source still answers.
The quota source reads a week of agent logs and takes the longest, so leave it out of `--only` when only the machines matter.

### Read the snapshot

The snapshot is a version 1 JSON object with `generatedAt`, `machine`, and `sources`.
Each selected source is `ok` with its fields or `failed` with an error.
A source omitted by `--only` has no entry.
A configured machine can be `ok`, `unreachable`, or `invalid`.
An unset machine command has no entry.

The field definitions are in `SnapshotReport` in `packages/schema/src/features/snapshot/snapshot.ts`.
See the [resources report](dash-resources.md#read-the-resources-report), [tasks report](dash-tasks.md#read-the-tasks-report), and [composed quota report](session-quota/compose-two-machines.md#read-the-composed-report) for their contents.
