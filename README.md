# orc

Orc takes one task and turns it into one pull request.
By default it runs the Pi agent in the nono sandbox, then the project checks, then no-mistakes.
With `--sandbox none` it runs Pi and the checks directly on the host.
This repository is a workspace with one package per area.
Today it holds one package, the run package, which ships the orc command.

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
| `packages/run` | The orc command and its checks, published as `@avi2dg/orc` |

## Related topics

- [The orc command](packages/run/README.md)
