---
kind: reference
---
# The backlog and the beat

The backlog holds tasks, and `orc beat` starts them when machines and accounts have room.

## Backlog location and state

Each task is a Markdown file with YAML frontmatter in `~/.orc/backlog`.
Set `ORC_HOME` to move the backlog.
The backlog lives only on the machine that runs `orc beat`.
A task's folder, `new`, `taken`, or `closed`, gives its state.

On a machine without a backlog, `orc backlog` prints `no backlog at <path>` and says where it lives.
With `--json`, the command returns an empty backlog.
Other `orc backlog` commands except `add` refuse, as does `orc merge`.

## Reference

- [Configure the backlog](backlog-configuration.md) describes machines, accounts, quotas, and projects.
- [Manage backlog tasks](backlog-tasks.md) describes task changes, holds, notes, and threads.
- [The beat and task runs](beat-runs.md) describes scheduling, status, and closing runs.
- [Run a backlog from the chat](../tasks/run-a-backlog.md) is a walkthrough.
