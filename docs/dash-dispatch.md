---
kind: how-to
---
# Run the dispatch panel

## Run the dispatch tool

To run the live dispatch panel, run `orc-dash panel dispatch`.
The panel reads `$ORC_HOME/backlog`, or `~/.orc/backlog` when `ORC_HOME` is unset or blank, and paints again every 10 seconds.
It shows each machine with its busy room, the taken and started claims as runs and each new task with why it waits.
Why a task waits comes from `orc backlog --json` on the machine the panel runs on, so a split child waits until its earlier sibling's PR merges and a parent waits on its children, as the beat holds them.
A backlog that does not exist reads as missing.
A folder or file the panel cannot read, including dispatch.json and projects.json, is named as unread, and so is an `orc backlog --json` that cannot run.
To print one frame of plain text instead, run `orc-dash panel dispatch --print`.
