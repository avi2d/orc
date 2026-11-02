# orc

Orc keeps a backlog of agent tasks, starts each on a machine with room, and ends each run in a pull request.
You add a task with `orc backlog add`, or say it in `orc chat`, which runs Pi on the orchestrator model `config.json` names.
Each `orc beat` starts the tasks whose dependencies closed done, on a machine with a free slot and an account with room.
The runner queues each run in pueue on its machine, over SSH for another machine, so the run outlives the beat.
A run gives one task to the Pi agent, by default in the nono sandbox, then runs the project checks, then no-mistakes, which opens the PR.
With `--sandbox none` it runs Pi and the checks directly on the host.
The beat closes the task of each finished runner run done or failed, with its PR link.
Orc runs only the providers and models its `config.json` names, as the run package README describes.
This repository is a workspace with one package per area.
The run package ships the orc command.
The other packages make up the terminal dashboard, moved in from tui-dash, and its `tui-dash` command.
It holds the quota, session quota, resources, queues, schedules, dispatch, tasks, alerts and ledger panels.
A panel package reaches another package only through the schema and ui packages, and `bun run lint` refuses any other import.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git, which clones the repository.
- The private list of host names and person names that no public line of orc may carry, as described under [The private list](#the-private-list).

## Install

To install orc:

1. Run `git clone https://github.com/avi2d/orc.git` to clone the repository.
1. Run `cd orc` to enter it.
1. Run `bun install --frozen-lockfile` to install the pinned dependencies.

## Run the checks

To run the checks:

1. Run `bun run build` to build the workspace.
1. Run `bun run lint` to lint it.
1. Run `bun run typecheck` to typecheck it.
1. Run `bun run test` to test it.

## The private list

The secrets gate in `bun run lint` fails a change that adds a term from a private list.
The list is a JSON file in the format [checks-secrets](https://github.com/avi2d/checks/blob/main/docs/gates/checks-secrets.md#the-private-pack) reads, with keys such as `hosts` and `names`.
It lives outside orc, in each machine's config file at `~/.config/checks/secrets-pack.json`.
Set `CHECKS_SECRETS_PACK` to read it from another path.
Lint fails on a machine with no list, so no change skips the gate.
In CI the `CHECKS_SECRETS_PACK` repository secret holds the list.

## Where things are

| Path | What it holds |
| --- | --- |
| `packages/run` | The orc command and its checks |
| `packages/schema` | The dashboard's shared decoders, machine sources and view models |
| `packages/ui` | The dashboard's panel module interface, theme and screen runner |
| `packages/alerts`, `packages/dispatch`, `packages/ledger`, `packages/queues`, `packages/quota`, `packages/resources`, `packages/schedules`, `packages/session-quota`, `packages/tasks` | One dashboard panel each |
| `packages/dashboard` | The dashboard host, which lays out the panels it is given |
| `packages/cli` | The `tui-dash` command, which composes the panels into the dashboard |
| `docs/tui-dash.md` | The guide to the dashboard and its panels |
| `dependency-cruiser.config.ts` | The panel border the lint holds every import to |
| `docs/adr` | The dashboard's decision records |

## Related topics

- [The orc command](packages/run/README.md)
- [The tui-dash dashboard](docs/tui-dash.md)
