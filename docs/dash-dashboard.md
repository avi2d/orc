---
kind: reference
---
# Run and configure the dashboard

The dashboard combines panels in a layout that you can configure.

## Run the dashboard

Run `orc-dash`, or `bun run dashboard` in the checkout.
To run from source, [set up a checkout and install its dependencies](contribute.md#run-orc-from-a-checkout).
The dashboard shows quota, attention items, queues, machine resources, and tasks.
Each panel title shows its refresh interval.
While a source loads, the dashboard shows a saved reading and its age.

On a screen under 120 columns or 36 rows, use Return to open the task levels and Escape to return.
Press `q` or Control C to quit.
To print a frame, run `bun run dashboard-print`.
Add `--width 40` for a narrow frame or `--width 240 --height 60` for a wide one.

### Use a wide screen

The default wide layout shows quota and notices above the attention, machines, queues, and projects panels.
Use the queue tabs to see schedules and dispatch.
The scheduled panel includes delayed [pueue](https://github.com/Nukesor/pueue) tasks, machine timers, and [GitHub](https://github.com) workflows.

| Key | What it does |
| --- | --- |
| Arrow keys | Select a row |
| Return or → | Open the selected row |
| Escape or ← | Go back |
| `l` | Open or close the ledger |
| `t` | Switch the projects board between today and all |

To show a remote heavy queue, set `ORC_DASH_REMOTE_HEAVY` to a command that prints its `orc heavy check --json`.
Set `ORC_DASH_RUNNERS` to a command that prints this machine's GitHub runner `.runner` files.
Without it, the queue lists pueue runs alone and the scheduled box has no GitHub workflows.
Configure task report commands as [Read the tasks report](dash-tasks.md#read-the-tasks-report) describes.

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

The ledger reads today's session files from the folder `ORC_DASH_LEDGER_SESSIONS` names, and says the variable is unset until you set it.
Each file ends in `.jsonl` and holds one JSON object a line.
A turn's object has `type` set to `message`, a `timestamp`, and a `message` with its `role` and its `content` text parts.
A `user` turn is your message, and an `assistant` turn is the agent's reply.

| Variable | What it holds |
| --- | --- |
| `ORC_DASH_LEDGER_SESSIONS` | The folder of session files the ledger reads |
| `ORC_DASH_LEDGER_CLASSIFY` | The shell command that reads one of your messages on stdin and prints something when the ledger should hide it |
| `ORC_DASH_LEDGER_ADDRESS` | The text a reply must open with to show, and the ledger shows the reply without it |
| `ORC_DASH_LEDGER_ACK` | A whole reply the ledger leaves out, such as a bare acknowledgement |
| `ORC_DASH_LEDGER_AGENT` | The name the full screen gives the agent, `assistant` when unset |

With `ORC_DASH_LEDGER_CLASSIFY` unset, the ledger shows every message of yours.
With `ORC_DASH_LEDGER_ADDRESS` unset, the ledger shows every reply whole.
The classifier exits zero or one, and a classifier that cannot run leaves the message shown.

## Configure the dashboard

The dashboard and every panel read one config file.
The config file is `ORC_DASH_CONFIG`, or else `orc-dash/config.json` under `XDG_CONFIG_HOME`, which is `~/.config` when unset.
It holds one JSON object, and every key it leaves out keeps its default.
Without the file, the dashboard shows its default layout in its default colours.
A key the command does not know, or a value out of range, stops the command with the file's path, the section and the issue.

| Key | What it holds |
| --- | --- |
| `accounts` | Each [Claude](https://claude.com) account's config folder, as [Show each Claude account](dash-quota.md#show-each-claude-account) tells |
| `appearance` | The colours of the tones and the providers, as [Set the colours](#set-the-colours) tells |
| `layout` | Which panels show where, as [Lay out the dashboard](#lay-out-the-dashboard) tells |
| `panels` | Each panel's own settings under its name |

Each panel reads only its own key under `panels`, the same in the dashboard and opened alone.
A panel with no settings refuses any key under its name.

| Setting | What it holds | Default |
| --- | --- | --- |
| `panels.alerts` | The alert rules, as [Configure the alerts](dash-reports.md#configure-the-alerts) tells | Every rule on its defaults |
| `panels.tasks.remote` | Whether `orc-dash panel tasks` shows the other machine's work alone instead of both machines' | `false` |

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
          { "height": "fill", "cells": [{ "stack": [{ "panel": "attention" }, { "panel": "resources" }, { "tabs": ["queues", "schedules", "dispatch"] }] }, { "panel": "tasks", "width": 2 }] }
        ]
      },
      {
        "atLeast": { "columns": 120, "rows": 36 },
        "rows": [
          { "height": "auto", "atMost": 0.55, "least": 8, "cells": [{ "panel": "quota" }, { "tabs": ["session-quota", "alerts"] }] },
          { "height": "fill", "cells": [{ "stack": [{ "panel": "attention" }, { "panel": "resources" }, { "tabs": ["queues", "schedules", "dispatch"] }] }, { "panel": "tasks", "width": 1 }] }
        ]
      }
    ],
    "narrow": ["quota", "attention", "session-quota", "queues", "dispatch", "resources", "alerts", "tasks"],
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
