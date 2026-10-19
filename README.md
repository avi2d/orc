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

## Running a task

To run the agent step on a task, run `bun run src/bin.ts run <task-file>` inside a clean git checkout of the project.
Orc refuses a checkout with uncommitted changes.
Orc commits to a new branch named `orc/<run-id>`, or to the name you pass with `--branch <name>`.
A branch name may hold only letters, digits, `.`, `_`, `-` and `/`.
Orc also refuses a checkout whose own git config sets any key outside a short list known to run no program.

The run needs `git`, `nono`, `pi` and `node` on the host PATH.
It also needs an opencode-go login in Pi, which `pi auth check --provider opencode-go` confirms.
Orc reads that login through Pi on the host and hands it to the sandbox, so a keychain-only setup is refused.

Orc takes the implementer agent file from the first of these that exists:

1. `~/.orc/agents/implementer.md`
1. `.orc/agents/implementer.md` in the project
1. `agents/implementer.md` bundled with orc

An agent file opens with a `---` header naming `model`, `thinking` and `tools`, and its body holds the instructions.
Orc routes only `opencode-go` models through the sandbox and refuses any other model.

Orc records the run as succeeded only when two facts hold.
Pi's final reply in its captured session stopped cleanly with `ORC_COMPLETE` on its own line.
The branch holds at least one new commit.
Otherwise orc records the run as failed with the reason and exits 1.
Each run keeps its task, evidence, agent log and Pi session in `~/.orc/runs/<run-id>`.

## Seeing runs

To list recent runs, run `bun run src/bin.ts runs`.
Orc keeps its records in `~/.orc`, outside every project repo.
To print the same facts as JSON, run `bun run src/bin.ts runs --json`.
Every JSON document names its version first as `schema`, starting at `orc.runs.v1`.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/args.ts` | The flag parsing for the orc command |
| `src/run.ts` | The `orc run` agent step: checkout checks, login preflight and the sandboxed Pi run |
| `src/run-record.ts` | The run report, its evidence file and its history rows |
| `src/run-session.ts` | The reading of the captured Pi session |
| `src/pi.ts` | The Pi agent command, its prompt and the check of its final reply |
| `src/agents.ts` | The agent file parsing and lookup |
| `agents` | The bundled agent files |
| `src/run-history.ts` | The `~/.orc` home folder, the SQLite run history and `orc runs` |
| `src/nono.ts` | The Sandcastle sandbox provider that runs each command in `nono run` |
| `src/host.ts` | The host-side processes and tools the provider runs outside nono, and the guard on host git |
| `src/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data and the Pi session folder, and routes the model credential |
| `src/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |
| `tests/unit` | The in-process unit tests |
| `tests/e2e` | The tests that run `src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1` |
| `tests/live` | The tests that run commands in a real nono sandbox, through `ORC_NONO_E2E=1 bun run test:live` |
| `.no-mistakes.yaml` | The check commands no-mistakes and CI run |
