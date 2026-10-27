# orc
Orc takes one task and turns it into one pull request.
It starts from a command in the terminal that takes the task as text or as a file.
It makes an isolated copy of the project on a new branch.
By default it runs the Pi agent inside a nono sandbox, then runs the project's checks.
With `--sandbox none` it runs Pi and the checks directly on the host.
It hands the branch to no-mistakes, which reviews it, pushes it and opens the PR.
You read the PR and merge it, since orc never merges.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git, tested on 2.56.0.
- nono from https://nono.sh, tested on 0.80.0, for the default sandbox.
- Node, tested on 24.22.1.
- Pi, the `@earendil-works/pi-coding-agent` npm package, tested on 1.4.0, with an opencode-go login.
- no-mistakes v1.90.0 or later, tested on v1.100.2, installed as [Installing no-mistakes](#installing-no-mistakes) says.

## Install

To install orc:

1. Run `git clone https://github.com/avi2d/orc.git` to clone the repository.
1. Run `cd orc` to enter it.
1. Run `bun install --frozen-lockfile` to install the pinned dependencies.
1. Run `cd packages/run` to enter the run package.
1. Run `bun link` to put the `orc` command on your PATH.

## Move an old launcher to the run package

After the release that moves orc into the run package, relink the Mac launcher on the Mac itself.
Enter packages/run and run `bun link` to point the launcher at the new entry point.
Then run `orc --version` and confirm it prints the version `packages/run/package.json` names.
The release performs no automated handoff, so the captain runs these steps when the release lands.

## Installing no-mistakes

Upstream's install script fetches the release GitHub marks latest, and upstream marks releases after v1.84.0 as prereleases, so the script installs a release orc refuses.
To install v1.100.2 instead:

1. Pick the archive for your machine: `no-mistakes-v1.100.2-darwin-arm64.tar.gz`, `no-mistakes-v1.100.2-darwin-amd64.tar.gz`, `no-mistakes-v1.100.2-linux-arm64.tar.gz` or `no-mistakes-v1.100.2-linux-amd64.tar.gz`.
1. Run `mkdir -p ~/.local/bin` to make the folder it goes in.
1. Run `curl -fsSL https://github.com/kunchenguid/no-mistakes/releases/download/v1.100.2/ARCHIVE | tar xz -C ~/.local/bin no-mistakes`, with the archive in place of `ARCHIVE`.
1. Put `~/.local/bin` on your PATH.
1. Run `no-mistakes --version` to check it.

no-mistakes prints `no-mistakes version v1.100.2`.

no-mistakes reviews with its own agent, which `agent` in `~/.no-mistakes/config.yaml` names.
Its daemon finds that agent on the PATH your login shell sets, not the PATH of the shell that runs orc.
With `agent: auto` it takes the first agent it finds, so to review with Pi:

1. Set `agent: pi` in `~/.no-mistakes/config.yaml`.
1. Put the folder holding `pi` on the PATH in your login shell profile, such as `~/.zprofile`.
1. Run `no-mistakes daemon restart`.

no-mistakes opens the PR only for an origin on a provider it supports, such as GitHub.
For another origin it pushes the branch and skips the `pr` and `ci` steps, and orc's result names that skip and its reason.

## Print the version

To print the orc version, run `orc --version` from any folder.

Orc prints `orc` and the version `package.json` names, and exits 0.
`--help` or `-h` prints the usage text and exits 0.
An unknown flag prints the usage text and exits 1.

## Running a task

To run a task, enter a clean git checkout of the target project and run `orc run <task-file>`.
Before the first task, add a `.no-mistakes.yaml` file to the target project root with at least one named check under `commands`.
Commit that file before running orc.
For example, a project checked by `bun test` keeps this `.no-mistakes.yaml` file.
```yaml
commands:
  test: bun test
```
Replace the command with the project's real check command.
Orc refuses a checkout with uncommitted changes.
Orc commits to a new branch named `orc/<run-id>`, or to the name you pass with `--branch <name>`.
A branch name may hold only letters, digits, `.`, `_`, `-` and `/`.
To resume the branch after a stop, enter the same target checkout and run `orc run --branch <name>` and orc skips the steps the run history marks passed.
On resume Sandcastle reuses the branch worktree, Pi resumes its prior session, and orc reattaches to no-mistakes with the same intent.
After a refusal, run the same resume command with `--allow` and the name from the report, or with `--answer` and the captain's answer for a question.
No-mistakes takes the word for that `--allow` kind, and the answer for that question.
Orc also refuses a checkout whose own git config sets any key outside a short list known to run no program.
To refuse checkouts carrying a marker file, set `ORC_REFUSE_MARKERS` to comma separated marker names.
Orc trims padding around each name and drops blank entries.
Orc checks each marker in the project directory and its parent and refuses a checkout carrying one.
An unset `ORC_REFUSE_MARKERS` names no marker and refuses no checkout for a marker.

The default sandbox run needs `git`, `nono`, `pi`, `node` and `no-mistakes` on the host PATH.
With `--sandbox none` the run needs the same tools except `nono`.
Orc runs `no-mistakes --version` before the sandbox starts and refuses a release older than v1.90.0.
It also needs an opencode-go login in Pi, which `pi auth check --provider opencode-go` confirms.
With the default sandbox, Orc reads that login through Pi on the host and hands it to the sandbox.
nono reads it with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TERM` set, and orc's check runs the same way.
So a key held only in the keychain or in an environment variable such as `OPENCODE_API_KEY` is refused, and a login Pi's `/login` stores in `~/.pi/agent/auth.json` works.
If nono cannot read the key during the run, its proxy answers Pi with `503 Service Unavailable`, and orc's result names that error.

## Running without a sandbox

To run Pi and the checks directly on the host, add `--sandbox none` to `orc run`, as in `orc run task.md --sandbox none`.
`--sandbox nono`, the default, keeps the nono sandbox.
Without a sandbox the run still gets its own worktree on its own branch, and nono need not be on the PATH.
Pi runs with your own environment and Pi config, so it can read and write anything your user can.
Orc points `GIT_CONFIG_GLOBAL` at a file in the run folder, so the commit identity Sandcastle sets never reaches your `~/.gitconfig`.
Pi writes its session straight into the run's `sessions/host` folder.

Orc takes the implementer agent file from the first of these that exists:

1. `$ORC_HOME/agents/implementer.md`, default `~/.orc/agents/implementer.md` when `ORC_HOME` is unset or empty
1. `.orc/agents/implementer.md` in the project
1. `agents/implementer.md` bundled with orc

An agent file opens with a `---` header naming `model`, `thinking` and `tools`, and its body holds the instructions.
Orc routes only `opencode-go` models through the sandbox and refuses any other model.

Pi in a run compacts its context once the context passes 150 thousand tokens, whatever the model's window.
Pi starts compaction at the window minus `compaction.reserveTokens`, so orc asks the host's Pi for each agent model's window through `pi --mode rpc`.
Orc writes the window minus 150000 as that model's reserve into the run's Pi folder, `session/agent/settings.json`, beside `models.json`.
Orc pins each agent model window in `models.json` as that provider model override `contextWindow`.
Orc refuses a model the host's Pi does not list, and a model whose window is 150 thousand tokens or less.

Once the checks pass, orc runs `no-mistakes axi run` on the branch with the task as its intent.
At each gate orc asks no-mistakes to fix the findings marked `auto-fix`, ignores those marked `no-op`, and accepts the fix review.
Orc refuses a no-mistakes gate holding an open review question without an `--answer` for that question.
Rerun with `--answer question-<id>="<text>"` and orc answers every open question before any gate response.
Orc refuses a no-mistakes gate holding an `ask-user` finding without `--allow ask-user`.
Orc leaves that no-mistakes gate parked for you to answer.

Orc records the run as succeeded only when four facts hold.
Pi's final reply in its captured session stopped cleanly with `ORC_COMPLETE` on its own line.
The branch holds at least one new commit.
The project's checks pass.
no-mistakes opened the PR and reported CI green.
Otherwise orc records the run as failed with the reason and exits 1.
Each run keeps its task, evidence, agent log and Pi session in `$ORC_HOME/runs/<run-id>`, default `~/.orc/runs/<run-id>` when `ORC_HOME` is unset or empty.
Its `no-mistakes.txt` and the run history hold the no-mistakes findings, their count, the gates orc answered, the final result and the PR link.
Its `report.md` carries the task, the branch, the status, the PR, the steps, the evidence, the signals, the findings and the result.
The terminal report names the run folder, the agent file, the session file and the report as full links, beside the PR link.

## Choosing the no-mistakes binary

To drive a no-mistakes binary the PATH does not find first:

1. Set `ORC_NO_MISTAKES_BIN` to the path of that binary.
1. Run the task as usual.

An unset or blank `ORC_NO_MISTAKES_BIN` runs the `no-mistakes` the PATH finds.
Orc refuses a binary whose `--version` fails, naming the binary and where to install no-mistakes.
Orc refuses a release older than v1.90.0, naming its version and the minimum.
Orc refuses a binary that prints no version.
A no-mistakes call that fails on an unknown flag or command names v1.90.0 in the run's result.
`src/no-mistakes.ts` drives no-mistakes through the `NoMistakesRunner` interface, and `subprocessNoMistakesRunner` is the runner `src/run.ts` builds.

## What the no-mistakes fork adds

Orc is developed against the avi2d/no-mistakes fork, and runs on upstream no-mistakes too.
The fork sends and prints the same axi commands, flags and fields as upstream v1.100.2.
These fork changes alter what a run meets, and the table names what happens on upstream without each.

| Fork change | What happens on upstream |
| --- | --- |
| A fresh run may replace an aborted run's unpublished mirror head | After a run aborts before its push and a commit leaves the branch, orc reports `no-mistakes refused to start` with `refusing to reconcile private mirror ref`, and the task needs a new branch |
| A fix round may only add commits | A fix agent that rebases or amends leaves the run failed and its branch off the recorded head, and orc reports the run failed with no-mistakes' error |
| Commits a fix agent makes take the worktree identity | A fix commit can carry the `no-mistakes <no-mistakes@local>` identity, so a project whose checks hold commit identity fails CI, and orc reports the run failed |
| A `reviewer_chain` setting falls through to the next reviewer when one is out of quota | Upstream has no `reviewer_chain`, so a reviewer out of quota fails the review step, and orc reports the run failed with no-mistakes' error |
| `pr.title_max_length` shortens a drafted PR title over the limit | Upstream has no `pr.title_max_length` and keeps the drafted title whole, so a project whose checks limit title length fails CI, and orc reports the run failed |
| The review step runs no agent when a branch changes only doc files or only workflow `cron:` values | Upstream reviews those branches with its agent, so the run spends a review and can stop at a review gate orc answers |
| Under `rebase.strategy: merge`, a CI conflict repair merges the base into the published branch | Upstream's repair rebases the published branch, so the next push can be refused, and orc reports the run failed with no-mistakes' error |

When a no-mistakes run ends failed, orc's result carries the error no-mistakes printed for it.

## Granting toolchain folders to the sandbox

With the default sandbox, the sandbox reads the system folders, the Homebrew and `/usr/local` program folders, `/nix` and the one mise install folder each of `bun`, `node` and `pi` resolves to.
Orc refuses a runtime the PATH finds anywhere else, naming the runtime and its path.
To run a runtime from another install folder, such as the one Bun's own installer makes in your home:

1. Set `ORC_TOOLCHAIN_DIRS` to the install folders, separated by colons.
1. Run the task as usual.

Orc grants a named folder only when a runtime and the file its link points to both sit inside it.
Orc refuses a relative entry and a folder that holds HOME, because the sandbox reads each granted folder whole.
`src/nono-profile.ts` holds the `ToolchainResolver` interface and the default layout, and `src/nono.ts` takes another resolver through its `toolchain` option.

## The agent provider contract

Orc runs Pi through Sandcastle's `pi` agent provider, and another Sandcastle provider takes its place on these terms.

- Orc passes `ORC_COMPLETE` as the completion signal, and its prompt asks the agent to print it on its own line once the work is committed.
- The provider reports the session id of each iteration, and its session storage reads that session's JSONL back from the host sessions folder.
- The host session file name ends in the session id and `.jsonl`, which is how orc finds the file and records the id for a resume.
- Orc counts the step complete only when the session's final assistant message stopped with `stop` and holds `ORC_COMPLETE` on its own line.
- On resume orc passes the recorded id as `resumeSession`, and the provider continues that session instead of starting a new one.
- Orc sums the `usage` input and output counts each session message carries into the run's token totals.

`src/pi.ts` builds the provider and checks the final reply, and `src/run-loop.ts` reads the session after each run.

## Seeing runs

To list recent runs, run `orc runs`.
Orc keeps its records in `~/.orc`, outside every project repo.
Set `ORC_HOME` to keep them somewhere else.
To print the same facts as JSON, run `orc runs --json`.
Every JSON document names its version first as `schema`, starting at `orc.runs.v1`.
To see one run step by step, run `orc show <run-id>`.
It lists each step with its agent, session, signals, latest score and evidence, every file as a full link.
To print the same facts as JSON, run `orc show <run-id> --json`.
Its JSON document names its version first as `schema`, starting at `orc.show.v1`.
To score a step, run `orc score <run-id> <step> <1 to 5> [note]`.
Use fix#1 to score the first fix attempt and plain fix scores the latest attempt in execution order.
Use the step id from orc show JSON to score one resumed checks row when an attempt ran twice.
Orc score refuses a score outside 1 to 5 with no write.
Orc score refuses an unknown run or an unknown step with no write.
Orc score keeps one row per score and orc show prints the latest score beside the signals.

## The backlog and the beat

Orc keeps one backlog of tasks in `~/.orc/backlog`, one Markdown file per task with its facts in YAML frontmatter.
`ORC_HOME` moves the backlog elsewhere when set.
A task file sits in `new`, `taken` or `closed`, and the folder it sits in is its state.
Two files beside the folders tell the beat where tasks may go.
`dispatch.json` names each machine, its slots and its start command, and the Claude accounts with the floor of room each must keep:

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc-start-task"] },
    { "name": "winbox", "slots": 4, "start": ["ssh", "winbox", "orc-start-task"] }
  ],
  "quota": { "accounts": ["main", "second"], "floorPercent": 15 }
}
```

`projects.json` names each project and its checkout on each machine:

```json
{ "projects": [{ "name": "orc", "checkouts": { "mac": "/Users/me/code/orc", "winbox": "/home/me/code/orc" } }] }
```

To add a task, run `orc backlog add <project> <task-file>`.
Add `--machine <name>` to run the task on that machine only, and `--depends-on <task-id>` once per task it waits for.
To see the backlog, run `orc backlog`.
It prints the new, taken and closed tasks side by side with the project list and each machine's busy slots beside them.
To print the same facts as JSON, run `orc backlog --json`, whose document names its version first as `orc.backlog.v1`.
To start what can start, run `orc beat`, from launchd or cron every few minutes.
Each beat reads quota with `clauth status --json` and the room on each machine before it takes any task.
A task starts only once three things hold:

1. Every task it depends on closed done.
2. Its project has a checkout on a machine with a free slot.
3. A Claude account has room at or above the floor.

The beat moves the task file from `new` to `taken` before it runs the start command, so of two beats only one takes a task.
After the claim survives a recount, the beat writes the task started before it runs the start command.
A task marked for a machine waits for a slot on that machine and never starts on another.
The start command reads the task from `ORC_TASK_ID`, `ORC_TASK_FILE`, `ORC_TASK_PROJECT`, `ORC_TASK_CHECKOUT`, `ORC_TASK_MACHINE` and `ORC_TASK_ACCOUNT`.
The beat starts it detached in its own session, never waits for it and never kills it.
So the start command and what it leaves running outlive the beat, even when launchd or cron ends the beat's process group.
Its output goes to `~/.orc/backlog/logs/<task-id>.log`, which `ORC_TASK_LOG` names.
From then on the task is the start command's to close, and one that fails leaves the task started until it is closed.
A missing start command exits 127 into its log and leaves the task started.
Only a failure to spawn the log wrapper closes the task as `start-failed`.
To print the beat as JSON, run `orc beat --json`, whose document names its version first as `orc.beat.v1`.
When a started task ends, run `orc backlog close <task-id> <done|failed> [reason]`.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/args.ts` | The flag parsing for the orc command |
| `src/run.ts` | The `orc run` agent step: checkout checks, login preflight and the Pi run in the selected sandbox |
| `src/run-record.ts` | The terminal run report, its evidence files and the `report.md` write |
| `src/history-write.ts` | The history checkpoints a run records as each step starts and ends |
| `src/report.ts` | The `report.md` shape and the signal facts it carries |
| `src/show.ts` | The `orc show` reading of one run from the history |
| `src/run-session.ts` | The reading of the captured Pi session |
| `src/pi.ts` | The Pi agent command, its prompt and the check of its final reply |
| `src/agents.ts` | The agent file parsing and lookup |
| `src/context-mark.ts` | The 150 thousand token compaction mark orc writes into each run's Pi folder |
| `agents` | The bundled agent files |
| `src/no-mistakes.ts` | The no-mistakes step: the gate answers, the refusals and the findings it records |
| `src/toon.ts` | The reading of the TOON output no-mistakes prints |
| `src/run-history.ts` | The records home, the SQLite run history and `orc runs` |
| `src/nono.ts` | The Sandcastle sandbox provider that runs each command in `nono run` |
| `src/host.ts` | The host-side processes and tools the provider runs outside nono, and the guard on host git |
| `src/nono-profile.ts` | The nono profile that lets a command write only the copy, its git data and the Pi session folder, and routes the model credential |
| `src/no-sandbox.ts` | The Sandcastle provider that runs Pi and the checks directly on the host |
| `src/git-config.ts` | The git config parsing that finds the credentials, includes and submodules a checkout carries |
| `src/dispatch/backlog.ts` | The backlog folders, the id reservation and the atomic take of a task |
| `src/dispatch/task-record.ts` | The task file and its frontmatter |
| `src/dispatch/config.ts` | The reading of `dispatch.json` and `projects.json` |
| `src/dispatch/quota.ts` | The quota reading from `clauth status --json` and the pick of an account |
| `src/dispatch/beat.ts` | The beat: room, placement, take and start |
| `src/dispatch/board.ts` | The terminal board and the `orc.backlog.v1` and `orc.beat.v1` JSON |
| `src/dispatch/args.ts` | The flag parsing for `orc backlog` and `orc beat` |
| `src/dispatch/cli.ts` | The `orc backlog` and `orc beat` commands |
| `../../tests/unit` | The in-process unit tests at the workspace root |
| `../../tests/e2e` | The tests that run `src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1`, at the workspace root |
| `../../tests/live` | The tests that run commands in a real nono sandbox, through the `test:live` script at the workspace root with `ORC_NONO_E2E=1` set |
| `../../.no-mistakes.yaml` | The check commands no-mistakes and CI run at the workspace root |
