---
kind: how-to
---
# Run a backlog from the chat

Hand orc a stream of work, so that it places each task on a machine and an account with room.

## Before you begin

- A task that ran by hand, as [Run your first task](run-your-first-task.md) shows.
- pueue on each machine that runs tasks, with its daemon started by `pueued -d`.
- A command that prints each account's room, or one login and the always-room command [The backlog and the beat](../run/backlog-and-beat.md) shows.

## Name the machines and the accounts

To tell the beat where tasks may run:

1. Save `~/.orc/backlog/dispatch.json` with each machine, its slots, its start command, and the quota.

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc", "runner", "start"] },
    { "name": "linux-box", "slots": 4, "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"] }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [
      { "name": "main", "tokenFile": "/Users/me/.secrets/main-token" },
      { "name": "second", "tokenFile": "/Users/me/.secrets/second-token" }
    ]
  }
}
```

## Name the projects

To tell the beat where each project's checkout is:

1. Save `~/.orc/backlog/projects.json` with each project and its checkout on each machine.

```json
{ "projects": [{ "name": "orc", "checkouts": { "mac": "/Users/me/code/orc", "linux-box": "/home/me/code/orc" } }] }
```

## Start the beat

To start what can start every few minutes:

1. Add `orc beat` to cron or launchd on the machine that holds the backlog.
1. Run `orc beat` once by hand and read its lines.

Each line names what the beat did or why a task waits.

## Add tasks and give them a priority

To hand over the work:

1. Run `orc chat` and say the tasks in plain words.
1. Run `orc backlog` to see each task with its id.
1. Run `orc backlog priority <task-id> <0-4>` for each task you want started, where 0 starts first.

A task with no priority never starts.
To add a task without the chat, run `orc backlog add <project> <task-file> --priority <0-4>`.

## Answer and merge

To keep the work moving:

1. Run `orc attention` to see everything that waits on you.
1. Answer a question with `orc backlog answer <task-id> <question-id>=<text>`, or say the answer in the chat.
1. Once a task closes done with a green pull request, run `orc merge <task-id>`, or tell the chat to merge it.

## Troubleshooting

### A task stays new

`orc backlog --json` gives each new task a `waiting` reason.
[The backlog](../concepts/backlog.md) lists the reasons and what clears each one.

### The beat starts nothing

A quota command that fails or prints a document orc cannot read leaves the quota unread, and the beat then starts nothing.
Run the quota command by hand and compare its output with the document [The backlog and the beat](../run/backlog-and-beat.md) shows.

## Related topics

- [How orc works](../index.md)
- [The beat](../concepts/beat.md)
- [Accounts and quota](../concepts/accounts-and-quota.md)
- [The chat](../concepts/chat.md)
