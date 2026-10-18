# orc
Orc takes one task and turns it into one pull request.
It starts from a command in the terminal that takes the task as text or as a file.
It makes an isolated copy of the project on a new branch.
It runs the Pi agent inside a nono sandbox, then runs the project's checks.
It hands the branch to no-mistakes, which reviews it, pushes it and opens the PR.
You read the PR and merge it, since orc never merges.

## Before you begin

- Bun 1.4.3, the version `.bun-version` pins.

## Install

To install orc:

1. Run `gh repo clone avi2d/orc` to clone the repository.
1. Run `cd orc` to enter it.
1. Run `bun install --frozen-lockfile` to install the pinned dependencies.

## Print the version

To print the orc version, run `bun run src/bin.ts --version`.

Orc prints `orc 0.1.0` and exits 0.
`--help` or `-h` prints the usage text and exits 0.
An unknown flag prints the usage text and exits 1.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/args.ts` | The flag parsing for the orc command |
| `src/nono.ts` | The Sandcastle sandbox provider that runs each command in `nono run` |
| `src/host.ts` | The host-side processes and tools the provider runs outside nono |
| `src/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data and the Pi session folder |
| `src/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |
| `tests/unit` | The in-process unit tests |
| `tests/e2e` | The tests that run `src/bin.ts`, git or nono as a process |
| `tests/live` | The tests that run commands in a real nono sandbox, through `ORC_NONO_E2E=1 bun run test:live` |
| `.no-mistakes.yaml` | The check commands no-mistakes and CI run |
