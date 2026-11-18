---
kind: how-to
---
# Snapshots and alerts

`orc-dash` can print snapshots and watch for alert events.

## Take a snapshot

See [Take a snapshot](dash-snapshot.md).

### Read the snapshot

See [Read the snapshot](dash-snapshot.md#read-the-snapshot).

## Watch for alerts

To stream alert events, run `orc-dash alerts --json`.
The command runs until it is stopped and prints one JSON object per line each time a rule fires.
It prints nothing else on stdout, so a listener reads it line by line, as in `orc-dash alerts --json | while read -r line; do ...; done`.
The events only report what crossed a limit, and what to do about one is up to the listener.
Each rule reads its own source on its own schedule, with the time limit the snapshot gives that source.
A read that fails or runs past its limit ends no episode and restarts no clock, and the other rules keep reading.
A rule starts no new read while its last one is still running, and reports that sample as failed.

| Rule | Source | When it fires |
| --- | --- | --- |
| `quota-pace` | `quota` | A window runs ahead of pace past its first tenth and runs out before its reset |
| `heavy-load` | `resources` | A machine stays over its load or memory limit in every sample for the sustained minutes, 5 by default |
| `long-task` | `tasks` | A task goes 15 minutes with no new milestone, then every 15 minutes while it has none, and once when it passes 2 hours in total |

Quota and heavy-load rules fire once per episode and reset when readings fall below their limits.
The task rule treats a change in state or detail as a milestone.
It counts quiet time from the first sample and total time from the task's first start.

### Configure the alerts

The settings are the `panels.alerts` object of the config file.
The config file is `ORC_DASH_CONFIG`, or else `orc-dash/config.json` under `XDG_CONFIG_HOME`, which is `~/.config` when unset.
Where the config file sets no `panels.alerts`, the file `ORC_DASH_ALERTS_SETTINGS` names is read as `panels.alerts`.
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

A machine name is the one `ORC_DASH_MACHINE` or `ORC_DASH_REMOTE_MACHINE` gives it, and a machine the list does not name has no heavy load rule.
A list in the file replaces the default list whole.

### Read the alert events

Each event is version 1 and carries its `rule` and sample time `at`.
The fields for each rule are defined by `AlertEvent` in `packages/schema/src/entities/alerts/contract/alerts.ts`.

### Record a verdict

A listener records what it made of each event in the verdict log, so the alerts panel can show it.
The log lives at `ORC_DASH_ALERTS_VERDICTS`, or else at `~/.local/state/orc-dash/alerts-verdicts.jsonl`.
It holds one JSON object per line, and a listener only ever appends to it.
`AlertVerdictRecord` in `packages/schema/src/entities/alerts/contract/alert-verdicts.ts` decodes each line.
When an event arrives, the listener appends it with `verdict` `null`.
Once it has judged the event, it appends the same event again with its verdict.
A reader checks `schemaVersion` first, and version 1 is the only version.
The alerts command itself writes nothing to the log.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `event` | The alert event exactly as `orc-dash alerts --json` printed it |
| `verdict` | `null`, or one line of the listener's text |
| `recordedAt` | The ISO instant the listener appended the line |

## Read the alerts panel

The dashboard's alerts tab shows each rule, its limits, last recorded fire, and the listener's verdict.
The panel reads the verdict log and settings, so an event appears only after a listener records it.
An unreadable log or invalid record is reported in the panel.

Run `orc-dash panel alerts --print` to print one frame.
Add `--width 40` for a narrow frame.
