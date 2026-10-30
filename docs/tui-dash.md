---
kind: how-to
---
# tui-dash
Tui-dash is a set of OpenTUI terminal panels and a dashboard composed from them, held in the orc workspace.
It holds the quota, session quota, resources, queues, schedules, dispatch, tasks, alerts and ledger panels.
It is built in Bun and Effect with one package per panel plus shared packages.
Each panel opens on its own in the terminal, and the dashboard lays out the panels a config file names.
The quota panel shows each account's quota windows, with health coloured bars, pace markers, verdicts and reset countdowns.
The resources panel shows CPU, memory, load, the busiest processes and NVIDIA GPUs on the machine it runs on.
With a second machine configured, it shows that machine's panels too.
The session quota panel estimates each agent session's share of every quota window from the local logs.
With a second machine configured, it merges that machine's session report, so an account both machines spend shows one estimate.
It flags each session spending over its fair share of a window that runs ahead of pace and runs out before its reset.
The queues panel shows the pueue queues of this machine and a second one.
It also lists the GitHub Actions runs of one repository that wait or run.
The dispatch panel shows the orc dispatcher's machines, the room on each, the runs it started and the tasks still waiting with why.
The tasks tool walks from the registered projects to one project's tasks and to one task.
It keeps a history of what each task used.
The `tui-dash` command runs the dashboard, opens one panel, and prints every source's readings as one JSON snapshot for a script to read.
It also watches quota pace, machine load and long tasks, and prints an alert event each time a rule fires.
The dashboard's alerts panel shows each rule, its limits, its last fire and the verdict a listener recorded.

## Before you begin

Bun, at the version `.bun-version` pins, is the only requirement.
Every other tool is optional.
A panel whose tool is missing says so on its own line, and the rest of the screen still works.

| Tool | What it adds | Without it |
| --- | --- | --- |
| `quota-axi` 0.1.56 | Quota windows the harness logs do not cover, from `quota-axi --full --json --provider` | Those providers read unreachable, and the windows the logs hold still show |
| `nvidia-smi`, on the `PATH` or in `/usr/lib/wsl/lib` under WSL | The GPU line of the resources panel | The resources panel leaves the GPU out |
| `herdr` 0.9.5 | Live agent sessions named by pane, from `herdr agent list` | Sessions in panes read as ended, and headless sessions still show |
| `pueue` 4.0.4 | The queues panel's jobs, from `pueue status --json` | The queues panel reads pueue unreachable |
| `no-mistakes` | The stages of a `full review fix` task, from `no-mistakes axi status` | Those tasks show no stages, and the projects box says `no-mistakes` did not start |
| `orc` | The stages of an `orc run` task, from `orc runs --json` and `orc show <run> --json` | Those tasks show no stages, and the projects box says `orc` did not start |
| `gh`, signed in to an account that can read the repository | The GitHub Actions runs the queues panel lists, from `gh run list`, and the runner repositories the dashboard reads through `gh api` | The actions panel reads gh unreachable |

A tasks report, a second machine and saved quota profiles each come from a shell command you set, and stay off until you set it.

## Install

To install tui-dash:

1. Run `git clone https://github.com/avi2d/orc.git` to clone the repository.
1. Run `cd orc` to enter it.
1. Run `bun install --frozen-lockfile` to install the pinned dependencies.
1. Run `mkdir -p ~/.local/bin && ln -s "$PWD/packages/cli/src/bin.ts" ~/.local/bin/tui-dash` to put the `tui-dash` command in a folder the `PATH` holds.
   When `~/.local/bin` is not on the `PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to the shell startup file and restart the shell.

The command runs the clone's code through `bun`, so `bun` must be on the `PATH` as well.

## Open one panel

To list the panels with what each shows, run `tui-dash panel --list`.
To run one panel live, run `tui-dash panel` with its name, such as `tui-dash panel quota`.
Press `q` or Control C to quit.
To print one frame of plain text instead, add `--print`, such as `tui-dash panel quota --print`.
Add `--width 120 --height 30` for a frame of that size.
Add `--color` to colour the printed frame with ANSI escapes, which works only with `--print`.
In the clone, `bun run dashboard panel quota` runs the same command.
A panel reads its settings from its own key under `panels` in the config file, as [Configure the dashboard](#configure-the-dashboard) tells.

## Run the quota tool

To run the live quota panel, run `tui-dash panel quota`.

The panel reads `quota-axi` on the machine it runs on and paints again every 30 seconds.
Two Claude accounts share the Claude brand clay, and Codex and OpenCode Go keep their own colours.
Each account gets its own block, titled with its account key.
A provider `quota-axi` reports as not set up gets no block, so the panel shows only the Claude, Codex and OpenCode Go accounts you use.
An exhaustion projection made early in a window reads muted and marked `early` instead of as a warning.
Press `q` or Control C to quit.

The panel first reads the quota readings that the Codex and Claude Code harnesses already write to their logs.
It asks `quota-axi` only about what those readings leave out.
It reads the logs of the login `quota-axi` would read.
Those are the Codex rollouts under `CODEX_HOME`, or `~/.codex`, and Claude Code logs under `CLAUDE_CONFIG_DIR`, or `~/.claude`.
While `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects the Claude account, no log is tied to that account, so the panel takes no Claude reading from the logs.
A Codex rollout holds the five hour and weekly windows with every token count.
A Claude Code log holds only a rejected call's window, which reads 0% left until its reset.
The panel does not ask `quota-axi` about a provider when the logs hold a reading of both its account windows.
Each of those readings must be younger than an hour, and its window must not have reset.
The hour is `quota-axi`'s own bound on reuse.
Its README lets `--max-age` serve a reading only while it is younger than the bound, and accepts at most one hour.
Saved Claude profiles use the same bound.
A reading an hour old or more, whether from quota-axi, a log or a saved profile, shows its age instead of a live percentage.
It shows no reset countdown either.
`quota-axi` is asked about every other provider, and always about OpenCode Go, whose harness logs no reading.
While a rollout answers for Codex, `quota-axi` is asked about no Codex account.
A second Codex login shows again only once the rollout's reading is an hour old.
A log reading also replaces a window `quota-axi` reported when it was read later and its window has not reset.
A block holding a window read from a log names where each window came from and how old the reading is, such as `week from codex rollout 38m ago`.
It also names how the reading joined the account: by credential key, or as an assumption when the log names no account.
The panel also reads the Claude readings that the Claude Code statusline hands the capture writer, as the [session quota README](../packages/session-quota/README.md#capture-usage-as-it-happens) describes.
Without that hook, the only Claude readings on disk are the rejections.

To print one frame of plain text instead, run `tui-dash panel quota --print`.

### Show saved profiles

The panel shows a block for each saved Claude profile other than the active one when `TUI_DASH_SAVED_PROFILES` names a shell command that prints them.
With `TUI_DASH_SAVED_PROFILES` unset or blank, the panel runs nothing for them and shows no saved block.

The command prints one JSON object with `schema` 2, the `active_profile` name or `null`, and `profiles`.
Each profile carries `name`, `active`, `provider`, `harness`, `tier` or `null`, `stale`, `fetched_at` or `null`, and `windows`.
Each window carries `label`, `utilization_pct` and `resets_at` or `null`.
Both panels title the Claude account with the active profile's name, such as `claude main` for a profile named `main`.

| Variable | What it sets |
| --- | --- |
| `TUI_DASH_SAVED_PROFILES` | The shell command that prints the saved profiles |

### Show each Claude account

The panel shows a block for each Claude account named by the config file's `accounts` key, titled `claude` and the account's name.
`accounts` maps each name to the absolute path of that account's own Claude config folder:

```json
{ "accounts": { "main": "/home/me/.claude-accounts/main", "second": "/home/me/.claude-accounts/second" } }
```

A name starts with a letter or digit and holds only letters, digits, `.`, `_` and `-`.
The command refuses two accounts on one folder, and a folder that is not a plain absolute path.
It also refuses `~/.claude`, since every session with no folder of its own shares that login.
An account's block shows the windows the statusline or the bridge read under that folder.
It says `no statusline reading in the last hour` when the last hour holds no reading.
The block never shows a reading taken under another folder, and the panel does not ask `quota-axi` about it.

To feed an account's block, give the `settings.json` in that account's folder a statusline that runs the capture writer:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /path/to/orc/packages/session-quota/dist/capture-bin.js claude-statusline",
    "refreshInterval": 30
  }
}
```

Run `bun run build` in the clone first, as the [session quota README](../packages/session-quota/README.md#build-the-writer) says, and put the clone's path in place of `/path/to/orc`.
Claude Code started with `CLAUDE_CONFIG_DIR` set to the folder reads that `settings.json` and runs the statusline with the same variable, so each reading names the folder.
The writer prints nothing, so to keep another statusline's text, read stdin once and pipe it to both commands.

## Run the session quota tool

To run the live session quota panel, run `tui-dash panel session-quota`.
To print one frame of plain text instead, run `tui-dash panel session-quota --print`.
To print the versioned JSON report, run `bun run session-quota-json`.
To print the report merged with a second machine's, run `bun run session-quota-composed-json`.
To stream flag alerts as JSON lines, run `bun run session-quota-alerts`.
The [session quota README](../packages/session-quota/README.md) documents both reports, the alert stream and how to configure the second machine.

## Run the resources tool

To run the live resources panel, run `tui-dash panel resources`.
The panel reads CPU, memory, load and processes on the machine it runs on and paints again every 10 seconds.
It adds GPU utilisation, VRAM and temperature where `nvidia-smi` answers, and leaves the GPU panel out where it does not.
On a short terminal it lists fewer processes, the same number on every machine.
Press `q` or Control C to quit.
To print one frame of plain text instead, run `tui-dash panel resources --print`.
To print the versioned JSON report, run `bun run resources-json`.

### Show a second machine's resources

The resources panel and the dashboard show a second machine's resources when a command that prints its report is configured.
The command runs on this machine and prints the other machine's `bun run resources-json` report.
Set these variables where the panel runs:

| Variable | What it holds |
| --- | --- |
| `TUI_DASH_REMOTE_RESOURCES` | The shell command that prints the other machine's report, such as `ssh -o BatchMode=yes -o ConnectTimeout=5 other-box 'cd orc && bun run resources-json'` |
| `TUI_DASH_REMOTE_MACHINE` | The other machine's name on its panels and lines, `remote` when unset |
| `TUI_DASH_MACHINE` | This machine's name on its panels and lines, `local` when unset |

The session quota tool reads the same two names.
With `TUI_DASH_REMOTE_RESOURCES` unset or blank, the panel shows this machine alone, under the titles `machine` and `gpu`.
Otherwise each machine's panels carry its name, this machine's first.
The command runs through `sh -c` with a 15 second limit, beside this machine's own read.
Its stdout must be that report alone, whitespace aside, so a login banner goes to stderr.
When the command fails or prints something else, the other machine's panel gives the reason.
A report generated more than a minute before this machine's read is left out, and the panel says how old it is.

### Read the resources report

The report is one JSON object on one line, and `ResourcesReport` in `packages/schema/src/contract/resources.ts` decodes it.
A reader checks `schemaVersion` first, and version 1 is the only version.
Each reading is `kind` `ok` with its `value`, `unreachable` with a `reason`, or `invalid` with an `issue`.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | The ISO instant of the read |
| `machine.cpu` | The busy `percent` over all the cores and the number of `cores` |
| `machine.memory` | `usedBytes` and `totalBytes` |
| `machine.disk` | `totalBytes` of the main data volume and `usedBytes`, the total less what is free, absent where the report predates it |
| `machine.load` | The 1, 5 and 15 minute load averages |
| `machine.processes` | Every process, busiest first, with its `pid`, `program`, `cpuPercent` and `residentBytes` |
| `gpu` | `null` where `nvidia-smi` does not answer, or else a reading of the `gpus` and their compute `apps` |
| `gpu.value.gpus` | Each card's `name`, `utilizationPercent`, `memoryUsedMiB`, `memoryTotalMiB` and `temperatureC` |
| `gpu.value.apps` | A reading of each compute app's `pid`, `program` and `memoryUsedMiB`, with `program` `null` where WSL cannot name it |
| `tasks` | A reading of each task's processes, present only where a tasks command is configured |

Each card and app figure is `kind` `value` with its `value`, or `not-reported` where `nvidia-smi` prints `[N/A]` or `[Not Supported]`.

### Read the tasks block

Where `TUI_DASH_TASKS` names a command that prints the tasks report, the resources report gains a `tasks` reading.
It holds one entry for each task with a live process on this machine, in the order of the tasks report.
A process belongs to a task when its working folder is one of the task's `folders` or inside one.
Where the listing missed its working folder, it takes the folder of its nearest sampled ancestor that has one.
A trailing `/` on a folder changes nothing.
It must also have started at or after the task's `firstStartedAt`, as far as the listing can tell.
The Mac gives a process's start to the whole second, and Linux to the whole second of its boot time and a clock tick.
So a process that started up to that long before the task may count as the task's.
A task that had ended by the time the process started cannot own it.
Of the tasks that could own a process, one still running outranks one that has ended.
So a task relaunched in a folder another task used since keeps its processes.
Between tasks both running or both ended, the one with the later `firstStartedAt` owns it, since a pool folder serves one task after another.
With `TUI_DASH_TASKS` unset or blank, the report has no `tasks` key and reads no task processes.
The tasks command and the process listing each get 5 seconds, well inside the 15 the other machine's report gets.
When either fails or runs out of time, the `tasks` reading gives the reason and the rest of the report still reads.

| Field | What it holds |
| --- | --- |
| `id` | The task's `id` from the tasks report |
| `processes` | How many live processes belong to it |
| `cpuSeconds` | The CPU time its live processes have used, with the time of the children they have already waited for |
| `cpuCores` | The cores it uses now, from two samples a second apart |
| `residentBytes` | The memory its processes hold now |
| `over.memory` | `true` when it holds more than a quarter of the machine's memory |

The cores limit, more than half the machine's cores for 10 minutes, needs a history of readings.
The report keeps none, so it carries `cpuCores` without a flag, and the tasks tool's sampler keeps that history.
On Linux the block reads `/proc`.
On the Mac it reads `ps` and `lsof` through `zsh`, and each process's own and waited-for children's time from `proc_pid_rusage`, through the bun that runs the report.
So a child that starts and exits between two samples counts in its parent's time on both.
The exception is on the Mac, where a process that execs drops the time of the children it has already waited for.
So `sh -c 'build; last'`, which runs its last command by exec, loses the build's time.
On the Mac a process this user may not read counts its own time from `ps` and none of its children's.

## Read the tasks report

The report is one JSON object on one line, and `TasksReport` in `packages/schema/src/contract/tasks.ts` decodes it.
A reader checks `schemaVersion` first, and version 1 is the only version.
Each instant parses to a timestamp, and a line the parser cannot read is an `invalid` reading with an `issue`.
A task relaunched since its first launch keeps that first start in `firstStartedAt`, so a reading from before the relaunch still belongs to it.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | The ISO instant of the read |
| `orchestrator` | The `name` and `version` of whatever printed it |
| `tasks` | Each task with its `id`, `title`, `project`, `kind`, `state`, `detail`, `startedAt`, `firstStartedAt` and `endedAt` or `null` |
| `tasks` state | One of `working`, `waiting`, `parked`, `blocked` or `done`, where a `done` task has an `endedAt` and every other has `null` |
| `tasks` folders | Every folder the work runs in |
| `tasks` branches | Every branch its CI runs on |
| `planned` | Each queued item in dispatch order, with its `id`, `title`, `project`, `kind`, `home`, `queuedOn` or `null`, `hold` or `null`, and the `after` ids that hold it. A `hold` names `owner`, `external` or `unstated` and carries a `reason`. A report without `planned` still decodes |
| `projects` | The registered project names the box lists even with no task in the window. A report without `projects` still decodes |
| `overhead` | The orchestrator's own agents, each with a `name` and its `folders` |
| `schedules` | Each dated item the orchestrator owns, with its `name`, `at` and `detail` |

To read the report, set these variables where the reader runs.

| Variable | What it holds |
| --- | --- |
| `TUI_DASH_TASKS` | The shell command that prints this machine's report |
| `TUI_DASH_TASKS_WATCH` | The files and folders the orchestrator writes, separated by `:`, whose change makes the tasks tool and the dashboard run this machine's report again |
| `TUI_DASH_REMOTE_TASKS` | The shell command that prints the other machine's report, such as `ssh -o BatchMode=yes -o ConnectTimeout=5 south.example.com 'harbor-tasks --json'` |
| `TUI_DASH_REMOTE_TASK_HISTORY` | The shell command that prints the other machine's task samples, one JSON object per line |
| `TUI_DASH_REMOTE_TASK_LIVE` | The shell command that prints the other machine's live usage, from `bun run tasks-live-json` |
| `TUI_DASH_MACHINE` | This machine's name on its readings, `local` when unset |
| `TUI_DASH_REMOTE_MACHINE` | The other machine's name on its readings, `remote` when unset |

Each command runs through `sh -c`.
The other machine's command has a 15 second limit.
This machine's has 5 seconds in the resources report and 2 minutes in the tasks tool.
The tasks tool and the dashboard start this machine's report at most once each 30 seconds, and never while one still runs.
With `TUI_DASH_TASKS_WATCH` set, such as `/home/me/harbor/state:/home/me/harbor/backlog.md`, they start it again only once something it names has changed.
A file has changed when its time or size has.
A folder has changed when an entry directly inside it comes, goes or changes, and an entry whose name starts with `.` does not count.
A report that failed runs again only once something it names has changed and 30 seconds have passed since the last run started.
With `TUI_DASH_TASKS_WATCH` unset or blank, the watch list is each home's `state` folder and `data/backlog.md` for one release.
The homes are `FM_TASKS_HOMES` when set, else every `fm-*` folder under `HOME` holding a `state` folder plus `FM_HOME` when it holds one and is not already listed.
This fallback goes once launchers set `TUI_DASH_TASKS_WATCH`.
With nothing to watch, the report runs once and never again.
Its stdout must be that report alone, whitespace aside, so a login banner goes to stderr.
With a command unset or blank, that machine yields no tasks and no error.
The resources report reads `TUI_DASH_TASKS` too, for its tasks block.

## Run the queues tool

To run the live queues panel, run `tui-dash panel queues`.
The panel reads pueue and the GitHub Actions runs and paints again every 10 seconds.
Each machine's panel counts the running, queued and paused tasks, the ended ones and the failed ones.
It lists the running tasks, then the ended ones newest first.
Each run shows its project, when it started, how long it took and its command, and a failed run says why, such as `exit 1` or `killed`.
A no-mistakes run copy shows the project its git origin names, read once on the machine that ran it.
It shows `unknown` until then, or when it has no origin.
The other machine's copies are read through the words before `pueue status` in `TUI_DASH_REMOTE_PUEUE`.
They show `unknown` when that command names pueue by its path or runs other shell commands before it.
In a terminal too narrow for the command beside the times, the command goes on a line of its own under its run.
The groups panel lists each machine's pueue groups with whether each is running, paused or resetting, and how many tasks it runs at once.
The actions panel lists the requested, pending, waiting, queued and in progress runs, newest first.
It counts how many run and how many wait.
When the terminal is too short for every run, each list shows fewer and counts the rest.
A source that has not answered yet, such as the other machine over ssh, shows as reading while the others paint.
Press `q` or Control C to quit.
To print one frame of plain text instead, run `tui-dash panel queues --print`.

The panel drops each task's environment as it reads pueue, since that environment can hold secrets.
It asks GitHub about the runs at most every 30 seconds, since each read takes five calls against the hourly API limit.

To configure the queues, set these variables where the panel runs:

| Variable | What it holds |
| --- | --- |
| `TUI_DASH_REMOTE_PUEUE` | The shell command that prints the other machine's `pueue status --json`, such as `ssh other-host pueue status --json` |
| `TUI_DASH_REMOTE_MACHINE` | The other machine's name on its panel, `remote` when unset |
| `TUI_DASH_MACHINE` | This machine's name on its panel, `local` when unset |
| `TUI_DASH_ACTIONS_REPO` | The repository whose runs the panel lists, such as `example/shop`. When unset, gh lists the runs of the repository the panel runs in, and the panel names it `this repository` |

With `TUI_DASH_REMOTE_PUEUE` unset or blank, the panel reads this machine's pueue alone.
The command runs through `sh -c` with a 20 second limit, beside this machine's own read.
The session quota tool reads the same two machine names.

## Run the tasks tool

To run the live tasks screen, run `tui-dash panel tasks`.
The screen shows the registered projects of this machine and of the other machine that `TUI_DASH_REMOTE_TASKS` reads, in three levels.
A project on both machines keeps one row, and each task and planned row names its machine whenever the screen reads two machines.
There a task id too long to sit beside its state and machine is clipped rather than the machine dropped.
Where the report names none, the first level lists only the projects with work in the last 7 days.
With `panels.tasks.remote` set to `true` in the config file, it shows the other machine's work alone instead, titled with that machine's name.
The first lists the projects, the second one project's tasks and the third one task.
A done task shows only when it ended today.
Each project row counts its working, waiting, parked, blocked, done and planned tasks.
The plan count gives the ready items, then a plus and the held items, and a dash when both are zero.
A total row under the header sums those counts when two or more projects show figures.
A project with nothing live and nothing queued shows dashes and reads dimmed.
Projects list with the most live tasks first, then the most working, then the earliest ready item, then the most held, then name order.
Each task row gives its id, then its state, the short model name, test time and time.
A ▶ marks a task whose live processes run work.
A live process runs work unless each task folder holding it rests under idle or done panes, so its mark agrees with the parked row.
A queued row gives its id and its planned or held state, with no time, model or test figures.
Rows list working, waiting, blocked and parked tasks first, then ready rows in dispatch order, then held rows, then ended tasks newest first.
Under a task, a line gives the tokens spent since local midnight.
Those are the tokens of the agent sessions working in its folders.
In the ticket, the model line also gives the task's spend as a multiple of its fair share while a limit runs ahead of pace past its first tenth.
An example is `7d Claude main 0.3× fair`.
A task with several sessions shows the share of its worst session.
A task over its fair share of a window running out before its reset is flagged with ⚑.
So is a task holding more than a quarter of the machine's memory, or more than half its cores for 10 minutes.
That flag is red while it holds and yellow after.
A flagged task whose live processes run work shows both marks, ▶ then ⚑.
The task level draws the task as a ticket.
Opening a queued row shows its ticket with its place in its home queue or what holds it.
A ready ticket names its place, such as starts next or second in line.
A held ticket names the wait and the reason where the report carries one.
It opens with the task's id and kind, then its title and description.
A status line in the state's colour follows with the state's mark, and a waiting task says what it waits on.
A full review fix held at a gate reads waiting for a decision with the gate mark and hides the worker detail.
A grey line gives when the task started, when it ended if done, for how long, and the machine that ran the task.
A task held at a gate counts the parked time from the pipeline there instead of the total.
Only a working task reads as running.
A working task whose folders all rest under idle or done panes reads as parked.
A pane counts for the folder its agent session log sits in, and the pane's own folder only steps in when the pane has no agent session.
The model line gives the short model name and an effort letter, then the tokens and the fair share.
The letter is S under 8,000 output tokens since local midnight, M under 30,000 and L from there.
The ticket then gives the CPU and peak memory the task kept, its live processes with ▶ on those that run work, and its pueue runs.
Each pueue run is named by the test, lint or typecheck commands it runs, or else by its first command.
A task the orchestrator no longer lists keeps its sampled figures, model line and test runs, and shows as unknown.
A source that fails says why above the projects while the others still paint.

| Key | What it does |
| --- | --- |
| `↑` or `↓` | Pick a row in the level you are in, or a process or test run of the task |
| Return or `→` | Step into the picked row |
| Escape or `←` | Step back one level |
| `q` or Control C | Quit |

The top line is the path to the level you are in, from `projects` through the picked project to the picked task.
A click on a row opens it, and a click on a name in the top line jumps to that level.
The level you are in has a heavy frame and a bright pick, and the picks it came through stay dimly highlighted.
A list longer than its box scrolls to keep the pick in sight and ends with a count of the rows it leaves out.
Each level is a 60 column box.
A screen 240 columns wide shows every level, one under 240 columns shows two, and one under 120 columns shows one.
It paints again every 10 seconds, and runs this machine's report again as [Read the tasks report](#read-the-tasks-report) tells.
To print one frame of plain text instead, run `tui-dash panel tasks --print`, and add `--width 120 --height 30` for a frame of that size.

The screen reads `TUI_DASH_TASKS` and `TUI_DASH_MACHINE` as the tasks report does, and this machine's pueue for the test runs.
It reads `TUI_DASH_REMOTE_TASKS` and `TUI_DASH_REMOTE_MACHINE` the same way, and it reads live processes there only when `TUI_DASH_REMOTE_TASK_LIVE` is set.
With `TUI_DASH_TASKS` unset or blank, it shows only the tasks sampled earlier and says so.

### Follow a task's stages

A task whose `kind` is one of these walks a row of stages.

| Kind | Stages |
| --- | --- |
| `full review fix` | build, intent, catch up with main, review, test, docs, lint, push, PR, CI, merge |
| `quick fix` | build, PR, CI, merge, and your rebuild when its detail or a branch says rebuild |
| `local only` | build, ready branch, your approval, land locally |
| `scout` | investigate, report, your calls, follow-ups filed |
| `orc run` | take task, isolated copy, agent, checks, fix up to 3 times, no-mistakes PR, report |

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

A full review fix reads its stages from `no-mistakes axi status` in the task's folders, by the task's branches.
An orc run lists them with `orc runs --json` in its folders, and reads the run newest on its branches with `orc show <run> --json`.
The other kinds read their stage from the task's detail.
The other machine's full review fix and orc run tasks read theirs over its tasks route, in the background beside its report.
A stage can hold a live task in a graver state than the orchestrator reports, but never in a milder one.
A failed stage holds it as blocked, one that needs you as waiting, and one waiting on something else as parked.
A blocked task shows its current stage as stopped, and says so when its validation is still running.
A done task shows every stage done.

The ticket draws a pill for each stage, its mark and its name in brackets, such as `[● CI]`.
The current stage wraps across lines with what is known of its reviewer, findings, fix round, checks passed and what it waits on.
It leaves out what the description or the status line already says.
The last line gives the last activity and the time in the current stage.
A sample counts as activity when the task used a twentieth of a core or spent tokens.
The stage line turns yellow after 5 minutes without activity and red after 15.
It also turns yellow when a live task has been in one stage for 2 hours.

### Keep the task history

A task's CPU and peak memory after its processes end come from samples the sampler keeps.
Each sample keeps each process's own CPU time and the time of the children it waited for.
So a process that ends keeps the time it used.
A child too short to fall in a sample counts in the parent that waited for it.
A sampled child its parent waited for counts once.
To run the sampler, run `bun run tasks-sample` where it keeps running, such as in a user service.
Every minute it reads each task's processes, and appends a line for each task with processes to a day file.
Each line keeps the task report detail.
A line keeps the spend and test runs read from this machine's pueue and session quota only when they changed.
Readers carry the latest kept spend and test runs forward for each task.
It reads the tasks report and the session quota in the background and goes by the last answer each gave.
Either can take most of a minute, and a sample that waited on it would leave gaps.
A task with none gets a line when its last process ends, and when the report, model or test runs change.
The sampler repeats unchanged spend and test runs after half the 7 day span, when a task ends, and in a final line when a task leaves the report.
A sampler that starts again goes on from the lines it kept.
The day files are in `$XDG_STATE_HOME/tui-dash/tasks`, or `~/.local/state/tui-dash/tasks` when that is unset.
The sampler keeps 8 of them, so the last 7 days are always whole, and removes older ones when a new day starts.
A round that fails says why on stderr, and the next round tries again.
The other machine keeps no samples of its own here, so set `TUI_DASH_REMOTE_TASK_HISTORY` to a command that prints its day lines, one JSON object per line.
The tasks tool and the dashboard read them for that machine's peaks the way they read the day files for this machine's.
The other machine's live usage needs its own command, so set `TUI_DASH_REMOTE_TASK_LIVE` to a command that prints its live report, such as `ssh south.example.com 'cd orc && bun run tasks-live-json'`.
The dashboard polls it in the background and checks that machine's tasks against their limits the way it checks this machine's.

## Run the dashboard

To run the live dashboard, run `tui-dash`, or `bun run dashboard` in the clone.
The dashboard shows at a glance how much each account has left and whether a limit runs out before it resets.
It also shows which agent is spending a limit that runs ahead, and how busy the machine is.
Each account lists its limits by their length, such as 5 hours, week, fable week and month, whatever its provider calls them.
Each limit shows the share left, a warning such as runs out in 1d 20h, and when it resets.
A limit read an hour old or more shows its age instead of its share and its reset.
A saved Claude profile read that long ago leaves its age to its rows, so its header does not repeat it.
A limit with a pace marks on its bar how much of its time is left, as the quota tool does.
Beside the share, a reserve column reads spare, over, on pace, no pace or used up.
A projection made early in a limit reads muted, such as may run out in 2d 7h.
Below the accounts, a flag names each agent spending over its share of a running-ahead limit that runs out before its reset by its project, such as tui-dash.
With a second machine configured, a flag for an agent there names that machine too.
A line says when that machine could not be checked.
A limit read an hour old or more flags no agent.
A line gives its age instead, such as claude main's week read 13h 0m ago, too old to flag its agents.
Below the flags, a line for each machine counts the pueue tasks running and queued, or says it is idle.
It warns of paused tasks, a paused group and a last run that failed.
A line for the GitHub Actions runs counts how many run and how many wait.
The last lines give the machine's CPU and memory, and each GPU's use and memory.
Past two GPUs, one line gives the busiest card's use and the memory of all of them.
With a second machine's resources configured, each machine's line starts with its name, and its GPUs follow it.
When that machine could not be read, its line gives the reason, or says how old its report is.
In the top row, the alerts tab gives each alert rule, as [Read the alerts panel](#read-the-alerts-panel) tells.
It paints again every 2 seconds.
Each box title pins its refresh cadence at the right end, such as machines ↻ 10s, and the glance lists the intervals at the right of its first line when they fit.
The ledger, quota and the GitHub reads refresh on longer cadences, and the paint never waits on them.
The dashboard saves its last readings in `$XDG_STATE_HOME/tui-dash/dashboard`, or `~/.local/state/tui-dash/dashboard` when that is unset.
On start, a box whose source has not answered yet shows its saved reading and says how old it is, such as saved 3m ago.
When the whole alerts panel does not fit in its box, it shrinks to one row per rule.
Each row gives the rule's last fire and verdict.
That summary always stays.
On a short terminal the rest drops the blank lines, then the saved Claude profiles, then the flags, and counts what it leaves out.
When even that does not fit, the rest is cut above the alerts summary, with a count of the rows it leaves out.
On a narrow one it drops the bars, then shortens the words around the numbers, then the reset.
At last it moves each warning to a row of its own.
Session shares, where each reading came from, the task and run lists, the process list and the load averages show only in their own panels.
That holds for the second machine too.
Those are `tui-dash panel quota`, `tui-dash panel session-quota`, `tui-dash panel queues` and `tui-dash panel resources`.
In the default layout, a screen under 120 columns or 36 rows opens the tasks levels one at a time on Return.
Those levels work as [Run the tasks tool](#run-the-tasks-tool) tells.
Escape from the projects comes back to the glance.
Press `q` or Control C to quit.
To print one frame of plain text instead, run `bun run dashboard-print` in the clone.
Add `--width 40` for a narrow frame, or `--width 240 --height 60` for a wide one.

### Use a wide screen

With the default layout, on a screen at least 120 columns wide and 36 rows tall, the dashboard lays its readings out in bands.
The top band holds quota and notices.
Notices holds gluttons and alerts under one shared title, opening on gluttons.
Below the top band, the machines box gives each machine's CPU, memory, disk and GPU bars.
A machine with a tasks report and no resources reading gives just its name.
Under each machine, a line says whether a task uses over a quarter of its memory or over half its cores.
When that machine's tasks report or task usage was not read, the line says so instead.
Under the machines, the queue box lists what runs and waits on both machines, and what ended there in the last day.
Its title counts the runs that run and wait, and apart from them the tasks queued in pueue, which have no row of their own.
When the title has no room for the counts, they are the box's first line instead.
Each row gives whether it is a pueue run or a CI run, what ran, how long it took and when it ended.
A pueue row names its machine when the box holds more than one machine name.
A CI run belongs to no machine, so it names none.
A pueue run started by a task carries the task's id.
How long a CI run took comes from its jobs, so the wait for a runner is left out.
Beside the machines, one projects board joins the tasks reports of both machines.
The board works as [Run the tasks tool](#run-the-tasks-tool) tells.
Press `t` to switch the board between today and all.
Today keeps done tasks whose end is after local midnight.
All keeps every task the samples hold.
One project keeps one row when its tasks live on both machines.
A task row names its machine when the board holds more than one machine name.
A screen 240 columns wide shows the machines and three levels, and a narrower one shows two boxes.

The scheduled box gives what runs next, soonest first, from both machines’ delayed jobs and dated items alongside this machine’s timers and workflows.
The queue box shares one title with the scheduled box, split on a bar, and each half opens on its hotkey.
It reads the systemd user timers on Linux and the user's own launch agents on macOS.
Launch agents installed by third party software stay out of the box.
It reads the scheduled GitHub workflows of every repository with a runner on this machine, in UTC as GitHub runs them.
The same workflow due at the same minute in several repositories reads as one row, such as `nightly in 2 repos`.
It also lists pueue tasks stashed with a delay, and the schedules the tasks report gives.
Each row says when it runs next and what it is.
A delayed, dated, timer or agent row names its machine when the box holds more than one machine name.
When no source holds anything the box says `nothing scheduled`, and when the rows cover every source it says `nothing else scheduled`.
A source that fails says why.

| Key | What it does |
| --- | --- |
| `↑` or `↓` | Pick a row in the level you are in |
| Return or `→` | Step into the picked row |
| Escape or `←` | Step back one level, and from the projects back to the machines |
| `l` | Open the ledger full screen, and again to close it, when the layout names the ledger |
| `t` | Switch the projects board between today and all |

A click on a row opens it.
Live processes are read on this machine, and on the other machine only when `TUI_DASH_REMOTE_TASK_LIVE` is set, so a task without that reading says so.
The CI runs and the scheduled workflows come from GitHub through `gh`.
The CI runs are read again once a minute at most.
Each repository's workflow files are read again once an hour, and a repository whose read failed is tried again after a minute.

| Variable | What it holds |
| --- | --- |
| `TUI_DASH_RUNNERS` | The shell command that prints the `.runner` files of this machine's GitHub runners, such as `cat ~/actions-runner/.runner` |
| `TUI_DASH_TASKS` | The shell command that prints this machine's tasks report, as [Read the tasks report](#read-the-tasks-report) tells |
| `TUI_DASH_REMOTE_TASKS` | The shell command that prints the other machine's tasks report, as [Read the tasks report](#read-the-tasks-report) tells |

With `TUI_DASH_RUNNERS` unset or blank, the queue lists pueue runs alone and the scheduled box has no workflows.

### Follow the ledger

The ledger is off by default, and shows once the layout names it, as [Lay out the dashboard](#lay-out-the-dashboard) tells.
Ledger holds today's conversation with one agent, read from its session files.
Press `l` to open the ledger full screen.
The full screen takes the whole display.
Ledger shows your messages and the agent's replies of today, newest last.
Your rows show ○, and the agent's rows show ●.
Each row shows its mark, its text, and its age.
When rows do not fit, the earlier ones fold into a faint `↑ N earlier` count.
In the full screen, press Return or click a message to open its whole text.
The open message shows its time, its speaker, and every line.
PageUp and PageDown move a screen of messages.
Press `l` or Escape to close the full screen.

### Fill the ledger

The ledger reads today's session files from the folder `TUI_DASH_LEDGER_SESSIONS` names, and says the variable is unset until you set it.
Each file ends in `.jsonl` and holds one JSON object a line.
A turn's object has `type` set to `message`, a `timestamp`, and a `message` with its `role` and its `content` text parts.
A `user` turn is your message, and an `assistant` turn is the agent's reply.

| Variable | What it holds |
| --- | --- |
| `TUI_DASH_LEDGER_SESSIONS` | The folder of session files the ledger reads |
| `TUI_DASH_LEDGER_CLASSIFY` | The shell command that reads one of your messages on stdin and prints something when the ledger should hide it |
| `TUI_DASH_LEDGER_ADDRESS` | The text a reply must open with to show, and the ledger shows the reply without it |
| `TUI_DASH_LEDGER_ACK` | A whole reply the ledger leaves out, such as a bare acknowledgement |
| `TUI_DASH_LEDGER_AGENT` | The name the full screen gives the agent, `assistant` when unset |

With `TUI_DASH_LEDGER_CLASSIFY` unset, the ledger shows every message of yours.
With `TUI_DASH_LEDGER_ADDRESS` unset, the ledger shows every reply whole.
The classifier exits zero or one, and a classifier that cannot run leaves the message shown.

## Configure the dashboard

The dashboard and every panel read one config file.
The config file is `TUI_DASH_CONFIG`, or else `tui-dash/config.json` under `XDG_CONFIG_HOME`, which is `~/.config` when unset.
It holds one JSON object, and every key it leaves out keeps its default.
Without the file, the dashboard shows its default layout in its default colours.
A key the command does not know, or a value out of range, stops the command with the file's path, the section and the issue.

| Key | What it holds |
| --- | --- |
| `accounts` | Each Claude account's config folder, as [Show each Claude account](#show-each-claude-account) tells |
| `appearance` | The colours of the tones and the providers, as [Set the colours](#set-the-colours) tells |
| `layout` | Which panels show where, as [Lay out the dashboard](#lay-out-the-dashboard) tells |
| `panels` | Each panel's own settings under its name |

Each panel reads only its own key under `panels`, the same in the dashboard and opened alone.
A panel with no settings refuses any key under its name.

| Setting | What it holds | Default |
| --- | --- | --- |
| `panels.alerts` | The alert rules, as [Configure the alerts](#configure-the-alerts) tells | Every rule on its defaults |
| `panels.tasks.remote` | Whether `tui-dash panel tasks` shows the other machine's work alone instead of both machines' | `false` |

### Lay out the dashboard

`layout.wide` lists the wide layouts, each with the smallest screen it fits in `atLeast.columns` and `atLeast.rows`.
The first wide layout the screen is at least as big as lays the panels out.
A screen smaller than every wide layout shows the narrow glance, which stacks the panels `layout.narrow` lists in that order.
A wide layout holds `rows` from top to bottom, and each row holds `cells` from left to right.
A row's `height` is `auto` or `fill`.
An `auto` row takes the height its panels need, up to the share of the screen `atMost` gives, and at least `least` rows.
A `fill` row takes a split of the height the `auto` rows leave, and at least `least` rows.
A cell is one `panel`, a set of `tabs` that share one box, or a `stack` of panels and tab sets from top to bottom.
A cell's `width` is its share of the row, and a cell without one has a share of 1.
A panel the layout does not name does not run, and a panel shows at most once in each wide layout.
`layout.narrowGivesWay` lists the narrow glance's panels in the order they give up rows when the glance does not fit.
The panels it leaves out give way after them, the last of `layout.narrow` first.

The default layout is this one.

```json
{
  "layout": {
    "wide": [
      {
        "atLeast": { "columns": 240, "rows": 36 },
        "rows": [
          { "height": "auto", "atMost": 0.55, "least": 8, "cells": [{ "panel": "quota" }, { "tabs": ["session-quota", "alerts"] }] },
          { "height": "fill", "cells": [{ "stack": [{ "panel": "resources" }, { "tabs": ["queues", "schedules"] }] }, { "panel": "tasks", "width": 2 }] }
        ]
      },
      {
        "atLeast": { "columns": 120, "rows": 36 },
        "rows": [
          { "height": "auto", "atMost": 0.55, "least": 8, "cells": [{ "panel": "quota" }, { "tabs": ["session-quota", "alerts"] }] },
          { "height": "fill", "cells": [{ "stack": [{ "panel": "resources" }, { "tabs": ["queues", "schedules"] }] }, { "panel": "tasks", "width": 1 }] }
        ]
      }
    ],
    "narrow": ["quota", "session-quota", "queues", "resources", "alerts", "tasks"],
    "narrowGivesWay": ["alerts", "quota", "session-quota"]
  }
}
```

To show the ledger beside the notices, add `{ "panel": "ledger" }` to the cells of a top row.

### Set the colours

`appearance.tones` sets the colour of each tone the panels paint with, as a `#rrggbb` hex such as `#ff5f5f`.
The tones are `primary`, `accent`, `warning`, `error`, `success`, `foreground`, `muted`, `subtle`, `faint`, `focus`, `pick` and `held`.
`appearance.providers` sets the colour of each provider's accounts under `claude`, `codex` and `opencode-go`.
A tone or provider left out keeps its default colour.
The colours hold in the dashboard, in a panel opened alone and in a frame printed with `--color`.

## Take a snapshot

To read every source once and print one JSON object, run `tui-dash snapshot --json`.
To read only some sources, name them in `--only`, separated by commas, such as `tui-dash snapshot --json --only resources,tasks`.
The sources are `quota`, `resources`, `queues` and `tasks`, and a name that is none of them stops the command before it reads anything.
The sources read at the same time, and each has its own time limit.
A source that runs past its limit or breaks reports `failed` with its error, and the others still report.
The command exits 0 whenever it prints the snapshot, however many sources failed.
Each source reads the variables its tool reads, so a second machine configured for a tool shows in that source too.

| Source | What it holds | Limit |
| --- | --- | --- |
| `quota` | The composed session quota report, with every account's windows, their pace and gate, and the flags, merged with the second machine's report where `TUI_DASH_REMOTE_SESSION_QUOTA` is set | 3 minutes |
| `resources` | This machine's resources report, then the one `TUI_DASH_REMOTE_RESOURCES` prints | 30 seconds |
| `queues` | This machine's pueue, then the one `TUI_DASH_REMOTE_PUEUE` prints, and the GitHub Actions runs that wait or run | 30 seconds |
| `tasks` | The tasks reports `TUI_DASH_TASKS` and `TUI_DASH_REMOTE_TASKS` print | 30 seconds |

The longest chain of commands a source runs ends inside its limit.
So a slow machine's reason lands in its reading, and the source still answers.
The quota source reads a week of agent logs and takes the longest, so leave it out of `--only` when only the machines matter.

### Read the snapshot

The snapshot is one JSON object on one line, and `SnapshotReport` in `packages/schema/src/contract/snapshot.ts` decodes it.
A reader checks `schemaVersion` first, and version 1 is the only version.
`sources` holds a key for each source the command read, and none for a source `--only` left out.
Each source is `status` `ok` with its fields, or `failed` with an `error`.
Each machine's reading is `kind` `ok` with its `value`, `unreachable` with a `reason`, or `invalid` with an `issue`.
A machine whose command is unset or blank has no entry.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | The ISO instant the last source answered |
| `machine` | This machine's name, `TUI_DASH_MACHINE` or `local` |
| `sources.quota.report` | The report the [session quota README](../packages/session-quota/README.md#read-the-composed-report) describes as the composed report |
| `sources.resources.machines` | Each machine's `name` and a `reading` of the report [Read the resources report](#read-the-resources-report) describes |
| `sources.queues.machines` | Each machine's `name` and a `pueue` reading of its `running` and `ended` tasks, how many are `queued` and `paused`, and its `groups` with their `status` and `parallel` count |
| `sources.queues.machines` tasks | Each task's `id`, `command`, `project` and `startedAt`, and for an ended task its `endedAt` and `result` |
| `sources.queues.machines` result | `kind` `success`, `exit` with its `code`, `spawn` with its `error`, `killed`, `errored` or `dependency` |
| `sources.queues.actions` | The `repo` and a reading of its `runs`, newest first, each with its `id`, `title`, `workflow`, `status` and `createdAt` |
| `sources.tasks.machines` | Each machine's `name` and a `reading` of the report [Read the tasks report](#read-the-tasks-report) describes |

## Watch for alerts

To stream alert events, run `tui-dash alerts --json`.
The command runs until it is stopped and prints one JSON object per line each time a rule fires.
It prints nothing else on stdout, so a listener reads it line by line, as in `tui-dash alerts --json | while read -r line; do ...; done`.
The events only report what crossed a limit, and what to do about one is up to the listener.
Each rule reads its own source on its own schedule, with the time limit the snapshot gives that source.
A read that fails or runs past its limit ends no episode and restarts no clock, and the other rules keep reading.
A rule starts no new read while its last one is still running, and reports that sample as failed.

| Rule | Source | When it fires |
| --- | --- | --- |
| `quota-pace` | `quota` | A window runs ahead of pace past its first tenth and runs out before its reset |
| `heavy-load` | `resources` | A machine stays over its load or memory limit in every sample for the sustained minutes, 5 by default |
| `long-task` | `tasks` | A task goes 15 minutes with no new milestone, then every 15 minutes while it has none, and once when it passes 2 hours in total |
| `nightly` | `nightly` | A CI workflow on a night schedule ends red, once per red run for each repository and workflow |

`quota-pace` and `heavy-load` fire once per episode.
An episode ends at the first sample below the limit, and the next sample over it starts a new one.
A machine is over its limits when its five minute load or its memory crosses either one.
It is below them only when both read below.
A machine's report generated more than a minute before the read counts as unread, so it neither extends nor ends an episode.
A task's milestone is a change in its `state` or its `detail` between two samples, since the tasks report dates none.
A task's quiet time starts when the command first sees it, so starting the command starts every task's quiet time.
The total counts from the task's `firstStartedAt`.
A task fires its total event once, even after it rests in a state the rule skips and comes back.
A gap between samples longer than the repeat fires one event, not one for each repeat it spans.
A night workflow stays filed while its runs stay red, and a green run on the same workflow files again on the next red one.
A cancelled or skipped rerun says nothing, so the rule looks back to the older run that decided.

### Configure the alerts

The settings are the `panels.alerts` object of the config file.
The config file is `TUI_DASH_CONFIG`, or else `tui-dash/config.json` under `XDG_CONFIG_HOME`, which is `~/.config` when unset.
Where the config file sets no `panels.alerts`, the file `TUI_DASH_ALERTS_SETTINGS` names is read as `panels.alerts`.
Where that variable names no file that exists, every rule runs on its defaults and no `alerts.json` beside the config file is read.
While no config file exists and that variable is unset, an `alerts.json` beside it is read as `panels.alerts`.
Without any of these files, every rule runs on its defaults.
The settings are one JSON object, and every key they leave out keeps its default.
A key the command does not know, or a value out of range, stops the command with the file's path and the issue.

| Key | What it holds | Default |
| --- | --- | --- |
| `quotaPace.everySeconds` | The seconds between two reads of the quota source | `60` |
| `heavyLoad.everySeconds` | The seconds between two reads of the resources source | `30` |
| `heavyLoad.sustainedMinutes` | How long every sample must stay over a limit before the rule fires | `5` |
| `heavyLoad.topProcesses` | How many processes the event lists by CPU and by memory | `5` |
| `heavyLoad.machines` | Each machine's `name`, its `loadAtLeast` and its `memory` limit, either `usedAtLeastPercent` or `availableUnderPercent` | `local` at load 10 or 90 percent used, `remote` at load 16 or under 15 percent available |
| `longTask.everySeconds` | The seconds between two reads of the tasks source | `30` |
| `longTask.quietMinutes` | The minutes without a milestone before the first event | `15` |
| `longTask.repeatMinutes` | The minutes between two events while the task stays without one | `15` |
| `longTask.totalHours` | The hours from the task's first start to its total event | `2` |
| `longTask.states` | The task states the rule watches | `working`, `waiting` and `blocked` |
| `nightly.everySeconds` | The seconds between two reads of the schedules and CI runs sources | `300` |
| `nightly.homes` | Each repository the rule files for, with the owner home its fix task names | No repository |

A machine name is the one `TUI_DASH_MACHINE` or `TUI_DASH_REMOTE_MACHINE` gives it, and a machine the list does not name has no heavy load rule.
A list in the file replaces the default list whole.

### Read the alert events

`AlertEvent` in `packages/schema/src/contract/alerts.ts` decodes each line.
A reader checks `schemaVersion` first, and version 1 is the only version.
Every event carries `rule` and `at`, the ISO instant of the sample that fired it.

| Rule | Fields |
| --- | --- |
| `quota-pace` | The window's `account`, `window`, `windowLabel`, `leftPoints`, `elapsedFraction` and `resetsAt`, and the `flags` raised on it, each with its `machine` |
| `heavy-load` | The `machine`, the episode's first sample as `since`, the limits `crossed`, the machine's `limits`, its `load` and `memory` with `usedPercent`, or `null` where unread, and `topProcesses` `byCpu` and `byMemory` |
| `long-task` | `reason` `quiet` or `total`, the `machine`, the `task` with its `id`, `title`, `project`, `state`, `detail` and `firstStartedAt`, then `quietSince`, `quietMinutes` and `totalMinutes` |
| `nightly` | The `repo`, the `workflow`, the red run's `runId` and `conclusion`, the owner `home`, and the next night slot as `recheckAt` |

### Record a verdict

A listener records what it made of each event in the verdict log, so the alerts panel can show it.
The log lives at `TUI_DASH_ALERTS_VERDICTS`, or else at `~/.local/state/tui-dash/alerts-verdicts.jsonl`.
It holds one JSON object per line, and a listener only ever appends to it.
`AlertVerdictRecord` in `packages/schema/src/contract/alert-verdicts.ts` decodes each line.
When an event arrives, the listener appends it with `verdict` `null`.
Once it has judged the event, it appends the same event again with its verdict.
A reader checks `schemaVersion` first, and version 1 is the only version.
The alerts command itself writes nothing to the log.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `event` | The alert event exactly as `tui-dash alerts --json` printed it |
| `verdict` | `null`, or one line of the listener's text |
| `recordedAt` | The ISO instant the listener appended the line |

## Read the alerts panel

The dashboard keeps the alerts panel in a tab with session-quota in the top row, so `tui-dash` shows it live.
The panel starts with an `alerts` line, then starts each rule with an `alert` line naming the rule as its events do.
Under it come the rule's limits from the settings file, its last fire and the listener's verdict.
The last fire is the latest event of that rule in the verdict log, with how long ago it fired and what crossed, such as `south over memory`.
Every event of that instant shows, so two machines over their limits at once show both.
The verdict is the latest verdict line of that rule.
When it judged an earlier fire than the last, the panel says the last fire has none, and shows the earlier fire beside its verdict.
A rule with no line in the log shows `none recorded`.
The panel reads only the log and the settings file, so a rule shows a fire only once a listener has recorded it.
When the settings file is refused, the command stops with the file’s path and the issue.
When the log cannot be read, a verdicts line gives the reason.
A line of the log that is not a record is counted on that line with its issue, and the other lines still show.
On a terminal too short for the whole panel, the summary gives each rule one row, such as `heavy-load 40m ago · expected, a nightly baseline runs on south`.
Its `alerts` line says when the log could not be read, or some of its lines are unreadable.
The panel changes nothing.
To print one frame of the panel alone as plain text, run `tui-dash panel alerts --print`, and add `--width 40` for a narrow frame.

## Run the checks

To run the checks:

1. Run `bun run lint` to run oxlint and every kit lint gate.
1. Run `bun run typecheck` to run `tsc` and the Effect language service diagnostics.
1. Run `bun run test:fast` to run the unit tier and the e2e files the change touches.
1. CI runs `bun run test` for the full unit and e2e suites.
1. Run `bun run build` to bundle every tool and the `tui-dash` command into each package's `dist/` and write the changelog.

The kit refuses a full mutation run outside CI, so the `mutation` workflow runs it when dispatched.
Run `bunx stryker run --mutate "packages/schema/src/sources/quota.ts"` to mutate one file against the unit suite.

## Find the code

| Path | What it holds |
| --- | --- |
| `packages/schema/` | The shared decoders, local and remote machine sources and view models |
| `packages/ui/` | The panel module interface, the shared theme, panel and text helpers, the live panel runner, and the screen runner with keys and clicks the tasks panel runs on |
| `packages/quota/` | The quota panel module and its OpenTUI rendering |
| `packages/session-quota/` | The session quota panel module, its OpenTUI rendering, JSON report and alert stream |
| `packages/resources/` | The resources panel module, its OpenTUI rendering and JSON report |
| `packages/queues/` | The queues panel module and its OpenTUI rendering |
| `packages/schedules/` | The scheduled panel module of what runs next |
| `packages/ledger/` | The optional ledger panel module and the session-file reader that fills it |
| `packages/dashboard/` | The dashboard host, which lays out the panel modules it is given from the layout setting |
| `packages/alerts/` | The alerts panel module of each alert rule and its one-frame print |
| `packages/tasks/` | The tasks panel module, its three levels and the sampler that keeps each task's history |
| `packages/cli/` | The `tui-dash` command, which composes the panel modules into the dashboard, opens one panel, prints the snapshot and the reports, or streams alerts |
| `scripts/` | The fast test tier behind `bun run test:fast` |
| `tests/unit/` | Unit tests, one directory per package |
| `tests/e2e/` | End-to-end tests that run the tools and scripts as a user does |
| `tests/fixtures/` | Recorded tool reports, host captures, invented session logs and pinned screens |
| `tests/lib/` | Test helpers |

## Troubleshooting

### The panel shows an unreachable line for every provider

The quota tool could not start `quota-axi`.
Install it and check it runs on the `PATH` of the machine the panel runs on.
A `claude saved` line that reads unreachable means the `TUI_DASH_SAVED_PROFILES` command failed, so run `sh -c "$TUI_DASH_SAVED_PROFILES"` and check its stdout.

### The other machine's resources panel says it is unreachable

The configured command failed, and the panel gives its reason, such as `sh exited 255` from ssh.
Run `sh -c "$TUI_DASH_REMOTE_RESOURCES"` on this machine and check that its stdout is the version 1 report alone.
A reason of `sh exited 127` means the shell ssh starts found no `bun` on its `PATH`, so put bun's folder on the `PATH` inside the command, such as `cd orc && PATH=$HOME/.bun/bin:$PATH bun run resources-json`.
Naming `bun` by its full path is not enough, because the `resources-json` script runs `bun` again by name.
