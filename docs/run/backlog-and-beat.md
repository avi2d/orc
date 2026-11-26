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

## Main CI alarms

Each beat identifies repositories from task PR links and the origin remotes of reachable checkouts in `projects.json`.
Task PR links keep identifying the repository after the task merges, including projects with checkouts only on worker machines.
For each repository, Orc reads push workflow runs on its default branch, regardless of who merged the PR or whether Orc updated it.
Orc makes one GraphQL call per [GitHub](https://github.com) host per beat, with a 30-second timeout.
The query covers the latest 20 commits and at most 100 check suites per commit.
A repository the token cannot resolve is skipped, and the other repositories on its host are still read.
A failed run raises a CI alarm in Orc chat with a link to the run.
A red run raises an alarm only at the current head of the default branch, or when it finished after Orc first saw the repository.
The first beat that sees a repository records when it saw it and posts no alarm from this check.
A later beat can still report a red run at the branch head.

## Reference

- [Configure the backlog](backlog-configuration.md) describes machines, accounts, quotas, and projects.
- [Manage backlog tasks](backlog-tasks.md) describes task changes, holds, notes, and threads.
- [The beat and task runs](beat-runs.md) describes scheduling, status, and closing runs.
- [Run a backlog from the chat](../tasks/run-a-backlog.md) is a walkthrough.
