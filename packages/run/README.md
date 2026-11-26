# orc
One chat to run your AI agent work on all your machines and models, with a backlog, live monitoring and Herdr App dashboards.
You say a task in `orc chat` to Pi on the orchestrator model, or add one with `orc backlog add`.
Each `orc beat` starts the tasks that can start, and `orc runner start` queues each run in pueue on its machine.
The beat later closes the task done, failed or stopped, with the PR link when its run opened one.
It also applies a worker split proposal, as [Task kinds](https://github.com/avi2d/orc/blob/main/docs/run/task-kinds.md#a-worker-split-proposal) shows.

## Before you begin

- Git 2.48 or later, tested on 2.56.0.
- nono from https://nono.sh, tested on 0.80.0, for a run you start by hand with `orc run` unless you pass `--sandbox none`.
- Node, tested on 24.22.1.
- Pi, the `@earendil-works/pi-coding-agent` npm package, tested on 1.4.0, with the login, token file or Pi packages each provider in [Configuring providers](https://github.com/avi2d/orc/blob/main/docs/run/configuring-providers.md) takes.
- no-mistakes v1.90.0 or later, tested on v1.100.2, installed as [Installing no-mistakes](https://github.com/avi2d/orc/blob/main/docs/run/installing-no-mistakes.md) says, for every run except `direct-PR` and `orc`.

## Install

To install orc:

1. Run `npm install -g @avi2dg/orc`.
1. Run `orc --version`.

Orc prints its version.
The npm package runs without Bun on Apple silicon macOS and Linux x64 with glibc.
If the compiled binary is missing, install Bun to run orc from source.
To upgrade orc, run the same install command again or follow [Updating orc](https://github.com/avi2d/orc/blob/main/docs/run/updating-orc.md).
To run orc from a checkout of the repository instead, follow [Contribute](https://github.com/avi2d/orc/blob/main/docs/contribute.md#run-orc-from-a-checkout).

## Run a task

To run one task, enter a clean checkout of the target project and run `orc run <task-file>`.
Queued tasks run without a per-agent sandbox, inside the isolated space around the whole agent system, as [Running without a sandbox](https://github.com/avi2d/orc/blob/main/docs/run/running-without-a-sandbox.md) describes.
[Running a task](https://github.com/avi2d/orc/blob/main/docs/run/running-a-task.md) names every flag and resume option.

## Print the version

To print the orc version, run `orc --version` from any folder.

Orc prints `orc` and the version `package.json` names, and exits 0.

## Get help

`orc --help` prints the commands grouped by what they do, each with one line on what it is for, and exits 0.
Bare `orc` prints the same overview on stderr and exits 1.
`orc <command> --help`, such as `orc run --help` or `orc backlog hold --help`, prints only that command: its usage, what it does, its options and examples.
`-h` works in place of `--help` everywhere.
A wrong or incomplete command prints the error, the usage of the nearest command and a pointer to its `--help`, and exits 1.
An unknown command or subcommand that is one or two typos away from exactly one real one names that one, such as `Did you mean orc run?`.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/features/running-a-task/run.ts` | The `orc run` agent step: checkout checks, agent files and the Pi run in the selected sandbox |
| `src/features/chat/chat.ts` | The `orc chat` start of Pi on the orchestrator model with the chat tools |
| `src/entities/review-gate/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `src/widgets/beat/beat.ts` | The beat: room, placement, take and start |
| `src/features/queueing-a-task/runner.ts` | The runner: the start, the kill and the token renewal through pueue |
| `src/app/dispatch-cli.ts` | The `orc backlog`, `orc attention`, `orc beat`, `orc runner`, `orc merge` and `orc heavy` commands |
| `agents` | The bundled agent files |

[Where every source file is](https://github.com/avi2d/orc/blob/main/docs/run/source-map.md) maps the rest of the package and the tests.

## Related topics

- [Running a task](https://github.com/avi2d/orc/blob/main/docs/run/running-a-task.md)
- [Running without a sandbox](https://github.com/avi2d/orc/blob/main/docs/run/running-without-a-sandbox.md)
- [Configuring providers](https://github.com/avi2d/orc/blob/main/docs/run/configuring-providers.md)
- [Account folders and orc login](https://github.com/avi2d/orc/blob/main/docs/run/accounts.md)
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
- [Updating orc](https://github.com/avi2d/orc/blob/main/docs/run/updating-orc.md)
- [Where every source file is](https://github.com/avi2d/orc/blob/main/docs/run/source-map.md)
