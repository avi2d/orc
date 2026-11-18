---
kind: how-to
---
# Run the resources panel

## Run the resources tool

To run the live resources panel, run `orc-dash panel resources`.
The panel reads CPU, memory, load and processes on the machine it runs on and paints again every 10 seconds.
It adds GPU utilisation, VRAM and temperature where `nvidia-smi` answers, and leaves the GPU panel out where it does not.
On a short terminal it lists fewer processes, the same number on every machine.
Press `q` or Control C to quit.
To print one frame of plain text instead, run `orc-dash panel resources --print`.
To print the versioned JSON report, run `bun run resources-json`.

### Show a second machine's resources

The resources panel and the dashboard show a second machine's resources when a command that prints its report is configured.
The command runs on this machine and prints the other machine's `bun run resources-json` report.
Set these variables where the panel runs:

| Variable | What it holds |
| --- | --- |
| `ORC_DASH_REMOTE_RESOURCES` | The shell command that prints the other machine's report, such as `ssh -o BatchMode=yes -o ConnectTimeout=5 other-box 'cd orc && bun run resources-json'` |
| `ORC_DASH_REMOTE_MACHINE` | The other machine's name on its panels and lines, `remote` when unset |
| `ORC_DASH_MACHINE` | This machine's name on its panels and lines, `local` when unset |


The session quota tool reads the same two names.
With `ORC_DASH_REMOTE_RESOURCES` unset or blank, the panel shows this machine alone, under the titles `machine` and `gpu`.
Otherwise each machine's panels carry its name, this machine's first.
The command runs through `sh -c` with a 15 second limit, beside this machine's own read.
Its stdout must be that report alone, whitespace aside, so a login banner goes to stderr.
When the command fails or prints something else, the other machine's panel gives the reason.
A report generated more than a minute before this machine's read is left out, and the panel says how old it is.

### Read the resources report

The resources report is one version 1 JSON object on one line.
It includes the reading time, machine CPU, memory, disk, load, and processes, plus GPU readings where available.
Each reading is `ok`, `unreachable` with a reason, or `invalid` with an issue.

The complete field definitions are in `ResourcesReport` in `packages/schema/src/entities/resources/contract/resources.ts`.

### Read the tasks block

When `ORC_DASH_TASKS` prints a tasks report, the resources report includes live task processes.
A process belongs to a task by its working folder and start time.
When multiple tasks match, a running task takes precedence, then the one with the later first start.
The block is absent when the command is unset.
A failed tasks or process read reports a reason without stopping the other readings.

| Field | What it holds |
| --- | --- |
| `id` | Task ID |
| `processes` | Live process count |
| `cpuSeconds` | CPU time, including waited-for children |
| `cpuCores` | Current cores used |
| `residentBytes` | Current memory |
| `over.memory` | Whether the task holds more than a quarter of machine memory |

The report does not retain the history needed to flag sustained CPU use.
The tasks sampler keeps that history.
