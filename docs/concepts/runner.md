---
aside: false
pageClass: wide-page
kind: explanation
---
# The runner

The runner is the part of orc on each machine that keeps a run alive after the beat has gone.
`orc runner start` is the start command the beat runs, and it hands the task to pueue, the queue on that machine.

![The runner: what keeps a run alive on its machine](../diagrams/runner.svg)

## The hand-off

The beat starts the start command detached and never waits for it.
`orc runner start` reads the task from the `ORC_TASK_*` variables the beat sets and queues `orc run` in the pueue group `orc`.
The group's parallel limit is the machine's slots from `dispatch.json`, so pueue holds a task back when the machine is full.
The task file goes to `~/.orc/runner/<task-id>.md` on that machine, and the run reads it from there.

## Another machine

To start on another machine, the start command names how to reach orc there after `--`, as in `orc runner start -- ssh linux-box orc`.
The task then travels as JSON on standard input to `orc runner queue` on the far side, so its text never passes through a remote shell.
SSH can drop once pueue holds the run, because pueue on that machine owns it.

## A queued run

The runner queues every run with `--sandbox none`, so a run from the backlog works on the host as your user.
It runs on the provider and the account the beat picked.
A ship task runs on the branch `orc/<task-id>`.
When the run starts, it fast-forwards the checkout's default branch from its remote first.

## The commands a beat reads it through

The beat never looks into pueue itself.

| Command | What it does |
| --- | --- |
| `orc runner result <task-id>` | Names pueue's state for the task and its latest run with its pull request |
| `orc runner answer <task-id>` | Hands your answers to a run that waits at its gate |
| `orc runner renew` | Replaces the token a task holds with a fresh one |
| `orc runner kill <task-id>` | Stops the run, and the next beat closes the task stopped |
| `orc runner load` | Prints the load the beat compares against a load limit |

## The heavy queue

Several agents that each start a test run or a build at once can overload one machine.
So each machine also queues those heavy calls through a second pueue group, `heavy`, with one slot.
Orc puts a stand in for each heavy tool, such as `bun`, `cargo` or `playwright`, first on the agent's `PATH`, and the stand in waits for its turn.

## Related topics

- [The beat](beat.md)
- [A run](run.md)
- [The runner](../run/runner.md)
- [The heavy queue](../run/heavy-queue.md)
