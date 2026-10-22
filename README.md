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

To run a task, run `bun run src/bin.ts run <task-file>` inside a clean git checkout of the project.
Orc refuses a checkout with uncommitted changes.
Orc commits to a new branch named `orc/<run-id>`, or to the name you pass with `--branch <name>`.
A branch name may hold only letters, digits, `.`, `_`, `-` and `/`.
To resume the branch after a stop, run `bun run src/bin.ts run --branch <name>` and orc skips the steps the run history marks passed.
On resume Sandcastle reuses the branch worktree, Pi resumes its prior session, and orc reattaches to no-mistakes with the same intent.
After a refusal, run the same resume command with `--allow` and no-mistakes takes the word for `ask-user` gates.
Orc also refuses a checkout whose own git config sets any key outside a short list known to run no program.

The run needs `git`, `nono`, `pi`, `node` and `no-mistakes` on the host PATH.
It also needs an opencode-go login in Pi, which `pi auth check --provider opencode-go` confirms.
Orc reads that login through Pi on the host and hands it to the sandbox, so a keychain-only setup is refused.

Orc takes the implementer agent file from the first of these that exists:

1. `~/.orc/agents/implementer.md`
1. `.orc/agents/implementer.md` in the project
1. `agents/implementer.md` bundled with orc

An agent file opens with a `---` header naming `model`, `thinking` and `tools`, and its body holds the instructions.
Orc routes only `opencode-go` models through the sandbox and refuses any other model.

Once the checks pass, orc runs `no-mistakes axi run` on the branch with the task as its intent.
At each gate orc asks no-mistakes to fix the findings marked `auto-fix`, ignores those marked `no-op`, and accepts the fix review.
Orc refuses a gate holding an open review question, and without `--allow` it also refuses a gate holding an `ask-user` finding, and leaves that gate parked for you to answer.

Orc records the run as succeeded only when four facts hold.
Pi's final reply in its captured session stopped cleanly with `ORC_COMPLETE` on its own line.
The branch holds at least one new commit.
The project's checks pass.
no-mistakes opened the PR and reported CI green.
Otherwise orc records the run as failed with the reason and exits 1.
Each run keeps its task, evidence, agent log and Pi session in `~/.orc/runs/<run-id>`.
Its `no-mistakes.txt` and the run history hold the no-mistakes findings, their count, the gates orc answered, the final result and the PR link.
Its `report.md` carries the task, the branch, the status, the PR, the steps, the evidence, the signals, the findings and the result.
The terminal report names the run folder, the agent file, the session file and the report as full links, beside the PR link.

## Seeing runs

To list recent runs, run `bun run src/bin.ts runs`.
Orc keeps its records in `~/.orc`, outside every project repo.
To print the same facts as JSON, run `bun run src/bin.ts runs --json`.
Every JSON document names its version first as `schema`, starting at `orc.runs.v1`.
To see one run step by step, run `bun run src/bin.ts show <run-id>`.
It lists each step with its agent, session, signals, latest score and evidence, every file as a full link.
To print the same facts as JSON, run `bun run src/bin.ts show <run-id> --json`.
Its JSON document names its version first as `schema`, starting at `orc.show.v1`.
To score a step, run `bun run src/bin.ts score <run-id> <step> <1 to 5> [note]`.
Use fix#1 to score the first fix attempt and plain fix scores the latest attempt in execution order.
Use the step id from orc show JSON to score one resumed checks row when an attempt ran twice.
Orc score refuses a score outside 1 to 5 with no write.
Orc score refuses an unknown run or an unknown step with no write.
Orc score keeps one row per score and orc show prints the latest score beside the signals.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/args.ts` | The flag parsing for the orc command |
| `src/run.ts` | The `orc run` agent step: checkout checks, login preflight and the sandboxed Pi run |
| `src/run-record.ts` | The terminal run report, its evidence files and the `report.md` write |
| `src/history-write.ts` | The history checkpoints a run records as each step starts and ends |
| `src/report.ts` | The `report.md` shape and the signal facts it carries |
| `src/show.ts` | The `orc show` reading of one run from the history |
| `src/run-session.ts` | The reading of the captured Pi session |
| `src/pi.ts` | The Pi agent command, its prompt and the check of its final reply |
| `src/agents.ts` | The agent file parsing and lookup |
| `agents` | The bundled agent files |
| `src/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `src/toon.ts` | The reading of the TOON output no-mistakes prints |
| `src/run-history.ts` | The `~/.orc` home folder, the SQLite run history and `orc runs` |
| `src/nono.ts` | The Sandcastle sandbox provider that runs each command in `nono run` |
| `src/host.ts` | The host-side processes and tools the provider runs outside nono, and the guard on host git |
| `src/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data and the Pi session folder, and routes the model credential |
| `src/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |
| `tests/unit` | The in-process unit tests |
| `tests/e2e` | The tests that run `src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1` |
| `tests/live` | The tests that run commands in a real nono sandbox, through `ORC_NONO_E2E=1 bun run test:live` |
| `.no-mistakes.yaml` | The check commands no-mistakes and CI run |
