---
kind: reference
---
# Tasks panel

The tasks panel shows projects, tasks, and a selected task.

## Run the tasks tool

Run `orc-dash panel tasks` to inspect projects, tasks, and a selected task.
The screen shows local and configured remote tasks.
A project on both machines has one row, and its tasks name their machine.
Set `panels.tasks.remote` to `true` to show only the other machine.

Each project lists its working, waiting, parked, blocked, done, and planned tasks.
A task ticket shows its state, model, tokens, CPU, memory, processes, and test runs.
A queued task shows its place or what holds it.

A ▶ marks a task whose processes are working.
A ⚑ marks a task over its fair share of a quota window running out before reset, over a quarter of machine memory, or using more than half its cores for 10 minutes.
A failed source reports its reason above the projects.

| Key | What it does |
| --- | --- |
| ↑ or ↓ | Select a row |
| Return or → | Open the selected row |
| Escape or ← | Go back |
| `q` or Control C | Quit |

Click a row to open it or a name in the top line to return to that level.
Run `orc-dash panel tasks --print` to print one frame.
Add `--width 120 --height 30` to set its size.

Configure task report commands as [Read the tasks report](#read-the-tasks-report) describes.
With `ORC_DASH_TASKS` unset, the screen shows only saved task samples.

### Follow the stages of a task

The panel shows stages for `full review fix`, `quick fix`, `local only`, `scout`, and `orc run` tasks.

The row of such a task gains a pipe column with a mark for each stage.

| Mark | Stage |
| --- | --- |
| ✓ | Done |
| ● | Working now |
| ◆ | Needs you |
| ◷ | Waiting, not on you |
| ✕ | Failed or stopped |
| ○ | Next, or not recorded |
| A dash | Skipped |

The ticket names the current stage and any known findings or wait.
A failed stage marks a task blocked, a stage needing you marks it waiting, and a stage waiting on something else marks it parked.
The stage line turns yellow after 5 minutes without activity and red after 15.
It also turns yellow when a live task has been in one stage for 2 hours.

### Keep the task history

Run `bun run tasks-sample` as a long-running service to save CPU, peak memory, spend, and test history.
The sampler writes to `$XDG_STATE_HOME/orc-dash/tasks`, or `~/.local/state/orc-dash/tasks` when unset.
It keeps eight day files.

Set `ORC_DASH_REMOTE_TASK_HISTORY` to a command that prints the other machine's samples as JSON lines.
Set `ORC_DASH_REMOTE_TASK_LIVE` to a command that prints its live report, such as `ssh south.example.com 'cd orc && bun run tasks-live-json'`.

## Read the tasks report

The tasks report is one version 1 JSON object on one line.
It includes the orchestrator, tasks, planned work, projects, overhead, and schedules.
A task's state is `working`, `waiting`, `parked`, `blocked`, or `done`.
A reader checks `schemaVersion` first.
The complete field definitions are in `TasksReport` in `packages/schema/src/entities/task/contract/tasks.ts`.

To read the report, set these variables where the reader runs.

| Variable | What it holds |
| --- | --- |
| `ORC_DASH_TASKS` | The shell command that prints this machine's report |
| `ORC_DASH_TASKS_WATCH` | The files and folders the orchestrator writes, separated by `:`, whose change makes the tasks tool and the dashboard run this machine's report again |
| `ORC_DASH_REMOTE_TASKS` | The shell command that prints the other machine's report, such as `ssh -o BatchMode=yes -o ConnectTimeout=5 south.example.com 'harbor-tasks --json'` |
| `ORC_DASH_REMOTE_TASK_HISTORY` | The shell command that prints the other machine's task samples, one JSON object per line |
| `ORC_DASH_REMOTE_TASK_LIVE` | The shell command that prints the other machine's live usage, from `bun run tasks-live-json` |
| `ORC_DASH_MACHINE` | This machine's name on its readings, `local` when unset |
| `ORC_DASH_REMOTE_MACHINE` | The other machine's name on its readings, `remote` when unset |

Each command runs through `sh -c`.

## Rerun the tasks report

The other machine's command has a 15 second limit.
This machine's has 5 seconds in the resources report and 2 minutes in the tasks tool.
The tasks tool and the dashboard start this machine's report at most once each 30 seconds, and never while one still runs.

With `ORC_DASH_TASKS_WATCH` set, such as `/home/me/harbor/state:/home/me/harbor/backlog.md`, they start it again only once something it names has changed.
A file has changed when its time or size has.
A folder has changed when an entry directly inside it comes, goes or changes, and an entry whose name starts with `.` does not count.

A report that failed runs again only once something it names has changed and 30 seconds have passed since the last run started.

With `ORC_DASH_TASKS_WATCH` unset or blank, the watch list is each home's `state` folder and `data/backlog.md` for one release.
The homes are `FM_TASKS_HOMES` when set, else every `fm-*` folder under `HOME` holding a `state` folder plus `FM_HOME` when it holds one and is not already listed.
This fallback goes once launchers set `ORC_DASH_TASKS_WATCH`.

With nothing to watch, the report runs once and never again.
Its stdout must be that report alone, whitespace aside, so a login banner goes to stderr.
With a command unset or blank, that machine yields no tasks and no error.
The resources report reads `ORC_DASH_TASKS` too, for its tasks block.
