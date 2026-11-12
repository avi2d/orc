# orc
Orc keeps a backlog of agent tasks and starts each on a machine with room.
You say a task in `orc chat` to Pi on the orchestrator model, or add one with `orc backlog add`.
Each `orc beat` starts the tasks that can start, and `orc runner start` queues each run in pueue on its machine.
The beat later closes the task done, failed or stopped, with the PR link when its run opened one.
It also applies a worker split proposal, as [Task kinds](https://github.com/avi2d/orc/blob/main/docs/run/task-kinds.md#a-worker-split-proposal) shows.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git 2.48 or later, tested on 2.56.0.
- nono from https://nono.sh, tested on 0.80.0, for the default sandbox.
- Node, tested on 24.22.1.
- Pi, the `@earendil-works/pi-coding-agent` npm package, tested on 1.4.0, with the login, token file or Pi packages each provider in [Configuring providers](https://github.com/avi2d/orc/blob/main/docs/run/configuring-providers.md) takes.
- no-mistakes v1.90.0 or later, tested on v1.100.2, installed as [Installing no-mistakes](https://github.com/avi2d/orc/blob/main/docs/run/installing-no-mistakes.md) says, for every run except `direct-PR`.

## Install

To install orc:

1. Run `git clone https://github.com/avi2d/orc.git` to clone the repository.
1. Run `cd orc` to enter it.
1. Run `bun install --frozen-lockfile` to install the pinned dependencies.
1. Run `cd packages/run` to enter the run package.
1. Run `bun link` to put the `orc` command on your PATH.

## Run a task

To run one task, enter a clean checkout of the target project and run `orc run <task-file>`.
[Running a task](https://github.com/avi2d/orc/blob/main/docs/run/running-a-task.md) names every flag and resume option.

## Print the version

To print the orc version, run `orc --version` from any folder.

Orc prints `orc` and the version `package.json` names, and exits 0.
`--help` or `-h` prints the usage text and exits 0, after any subcommand too, such as `orc run --help`.
An unknown flag prints the usage text and exits 1.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/run.ts` | The `orc run` agent step: checkout checks, agent files and the Pi run in the selected sandbox |
| `src/chat.ts` | The `orc chat` start of Pi on the orchestrator model with the chat tools |
| `src/entities/review-gate/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `src/dispatch/beat.ts` | The beat: room, placement, take and start |
| `src/dispatch/runner.ts` | The runner: the start, the kill and the token renewal through pueue |
| `src/dispatch/cli.ts` | The `orc backlog`, `orc beat`, `orc runner` and `orc merge` commands |
| `agents` | The bundled agent files |

[Where every source file is](https://github.com/avi2d/orc/blob/main/docs/run/layout.md) maps the rest of the package and the tests.

## Related topics

- [Running a task](https://github.com/avi2d/orc/blob/main/docs/run/running-a-task.md)
- [Running without a sandbox](https://github.com/avi2d/orc/blob/main/docs/run/running-without-a-sandbox.md)
- [Configuring providers](https://github.com/avi2d/orc/blob/main/docs/run/configuring-providers.md)
- [Installing no-mistakes](https://github.com/avi2d/orc/blob/main/docs/run/installing-no-mistakes.md)
- [Choosing the no-mistakes binary](https://github.com/avi2d/orc/blob/main/docs/run/choosing-the-no-mistakes-binary.md)
- [What the no-mistakes fork adds](https://github.com/avi2d/orc/blob/main/docs/run/no-mistakes-fork.md)
- [Granting toolchain folders to the sandbox](https://github.com/avi2d/orc/blob/main/docs/run/toolchain-folders.md)
- [How orc runs Pi](https://github.com/avi2d/orc/blob/main/docs/run/how-orc-runs-pi.md)
- [Seeing runs](https://github.com/avi2d/orc/blob/main/docs/run/seeing-runs.md)
- [The backlog and the beat](https://github.com/avi2d/orc/blob/main/docs/run/backlog-and-beat.md)
- [Parked runs](https://github.com/avi2d/orc/blob/main/docs/run/parked-runs.md)
- [The attention queue](https://github.com/avi2d/orc/blob/main/docs/run/attention-queue.md)
- [Task kinds](https://github.com/avi2d/orc/blob/main/docs/run/task-kinds.md)
- [Delivery modes](https://github.com/avi2d/orc/blob/main/docs/run/delivery-modes.md)
- [Merging a task's PR](https://github.com/avi2d/orc/blob/main/docs/run/merging-a-tasks-pr.md)
- [Adding tasks from a chat](https://github.com/avi2d/orc/blob/main/docs/run/chat.md)
- [The runner](https://github.com/avi2d/orc/blob/main/docs/run/runner.md)
- [The heavy queue](https://github.com/avi2d/orc/blob/main/docs/run/heavy-queue.md)
- [Move an old launcher to the run package](https://github.com/avi2d/orc/blob/main/docs/run/move-an-old-launcher.md)
- [Where every source file is](https://github.com/avi2d/orc/blob/main/docs/run/layout.md)
