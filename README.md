# orc

Orc takes one task and turns it into one pull request.
By default it runs the Pi agent in the nono sandbox, then the project checks, then no-mistakes.
With `--sandbox none` it runs Pi and the checks directly on the host.
This repository is a workspace with one package per area.
Today it holds one package, the run package, which ships the orc command.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git, which clones the repository.

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

## Where things are

| Path | What it holds |
| --- | --- |
| `packages/run` | The orc command and its checks, published as `@avi2dg/orc` |

## Related topics

- [The orc command](packages/run/README.md)
