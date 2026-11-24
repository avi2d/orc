---
kind: how-to
---
# Show orc in the Herdr App

The `orc` layout adds Board, Resources, Agents, and Inbox tabs to the [Herdr App](https://herdr.dev), with chat available on each tab.
Run `orc app install` after each orc upgrade to update the mods.
The command builds mods from a checkout, so a separate `bun run build` is not needed.

## Before you begin

- The Herdr App, run at least once so that `~/.config/herdr-app` exists.
- `orc` on the `PATH` of your login shell, since the mods run it through the App.
- `orc-dash` on that `PATH` too, for the Resources tab.
- For a second machine on the Resources tab, `ORC_DASH_REMOTE_RESOURCES` and `ORC_DASH_REMOTE_PUEUE` set where the App runs, as [orc-dash](dash.md) describes.

## Install the layout

To install the layout:

1. Run `orc app install`.
1. Run `herdr-app do layout.switch --name orc`, or press the `layout.switch` key until the `orc` layout shows.
   Check `keys.json` for your `layout.switch` binding.
   Use it again to return to your other layout.

The install command copies the `orc-tabs`, `orc-board`, `orc-task`, `orc-resources`, `orc-agents`, `orc-changes`, `orc-inbox`, and `orc-drawer` mods into `~/.config/herdr-app/mods/`.
It also copies `orc.json` and `orc.svg` to `~/.config/herdr-app/layouts/`.
It adds `cmd-1`, `cmd-2`, `cmd-3`, `cmd-4`, and `cmd-k` under `layout:orc` in `keys.json`.
Existing bindings stay in place and are reported as skipped.
The command writes only names beginning with `orc`, leaving Herdr's own mods and layouts untouched.

## Read the tabs

| Tab | Key | What it shows |
| --- | --- | --- |
| Board | `cmd-1` | The backlog tasks in five lanes, and the task panel for the selected card |
| Resources | `cmd-2` | Each subscription's quota windows, and each machine's cores, load, memory, disk and running orc runs |
| Agents | `cmd-3` | The runs and the queued tasks, and the selected run's steps, step output and changes |
| Inbox | `cmd-4` | Every open question, decision, hold and PR that waits for you, across all tasks |

The tabs refresh while visible and show a reason when a command fails.

## Answer in the Inbox

Select **Inbox** or press `cmd-4` to see everything that waits for you in one list, oldest first.
The Inbox reads `orc backlog --json`, `orc attention --json`, `orc runs --json`, and `orc backlog thread <task> --json` for each task that waits.
Each item shows its task, who asks, the question, and its options.
An option with a picture shows as a tile, and any other option shows as a button.
On a decision the decider escalated, the option it recommends is outlined and its recommendation shows below the options.

To answer a question or a hold:

1. Click an option, or type into the answer box and press Enter or **Send**.
1. The Inbox runs `orc backlog answer <task> <id>=<answer>` for a question and `orc backlog answer <task> <answer>` for a hold, as the Board task panel does, and drops the item once the answer is recorded.

To merge a PR that waits:

1. Click **Approve**.
1. Confirm the dialog, and the Inbox runs `orc merge <task> --basis captain-word`.

When a command fails, the item shows the command and the first line of its error.

## Tab guides

<div id="read-the-board-tab"><span id="read-a-task"></span><span id="read-the-resources-tab"></span></div>

[Board and Resources](herdr-app-board.md) covers tasks, quota, and machine capacity.
On the Board tab, click the count in the **Awaiting you** lane header to open the Inbox, as `cmd-4` does.

<div id="follow-a-run-in-the-agents-tab"><span id="approve-a-run-s-pr"></span><span id="read-a-run-s-changes"></span><span id="chat-with-orc"></span></div>

[Runs and chat](herdr-app-agents.md) covers the Agents tab and chat drawer.
On the Agents tab, click the count on the **Awaiting you** status filter to open the Inbox, as `cmd-4` does.
The Project row shows runs for configured projects by default.
Choose **All runs** to include runs from other projects.
A merged PR shows its run as Done, and a closed PR shows its run as Failed.

<div id="start-a-scratch-app"><span id="recapture-the-board-screenshots"></span><span id="change-the-mods"></span></div>

[Develop the mods](herdr-app-development.md) covers the scratch App and screenshots.

## Related topics

- [The orc-dash dashboard](dash.md)
- [Contribute](contribute.md)
