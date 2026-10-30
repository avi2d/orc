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
- Pi, the `@earendil-works/pi-coding-agent` npm package, tested on 1.4.0, with the login or token file each provider in [Configuring providers](#configuring-providers) takes.
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
Resume takes the sandbox the earlier run recorded, so a no-sandbox run resumes without a sandbox with no flag.
Orc refuses a resume whose `--sandbox` names another kind than the one recorded.
A run recorded before orc stored the sandbox takes it from the flag, with nono as the default.
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
On a provider that takes a Pi login, the run also needs that login in Pi, which `pi auth check --provider <id>` confirms.
With the default sandbox, orc reads that login through Pi on the host and hands it to the sandbox.
nono reads it with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TERM` set, and orc's check runs the same way.
So a key held only in the keychain or in an environment variable is refused, and a login Pi's `/login` stores in `~/.pi/agent/auth.json` works.
This refusal applies to `--sandbox none` as well, so write a key held only in an environment variable to the Pi auth file first.
With the default sandbox, if nono cannot read the key during the run, its proxy answers Pi with `503 Service Unavailable`, and orc's result names that error.

Orc takes the implementer agent file from the first of these that exists:

1. `$ORC_HOME/agents/implementer.md`, default `~/.orc/agents/implementer.md` when `ORC_HOME` is unset or empty
1. `.orc/agents/implementer.md` in the project
1. `agents/implementer.md` bundled with orc

An agent file opens with a `---` header naming `thinking`, `tools` and optionally `model`, and its body holds the instructions.
The bundled agent files name no model.
An agent file that names no model takes the one `models` in `config.json` names for its role, and orc refuses a run when neither names one.
Orc runs only a model whose provider `config.json` names, and refuses any other model.
Orc refuses an implementer and a fixer that name models from different providers.

With the default sandbox, Pi in a run compacts its context once the context passes 150 thousand tokens, whatever the model's window.
Pi starts compaction at the window minus `compaction.reserveTokens`, so orc asks the host's Pi for each agent model's window through `pi --mode rpc`.
With the default sandbox, orc writes the window minus 150000 as that model's reserve into the run's Pi folder, `session/agent/settings.json`, beside `models.json`.
With the default sandbox, orc pins each agent model window in `models.json` as that provider model override `contextWindow`.
Orc refuses a model the host's Pi does not list, or one whose window is 150 thousand tokens or less.
That refusal applies to both sandboxes.
With `--sandbox none` on a Pi login provider, Pi reads your Pi config, compaction included, so the fixed mark does not apply.
On a token file provider Pi reads the run's own Pi folder, so the mark applies there too.

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
They also name the reviewer that served the review, as `axi status` gives it in `reviewer_agent`, or say no-mistakes named none.
Its `report.md` carries the task, the branch, the status, the PR, the steps, the evidence, the signals, the findings and the result.
The terminal report names the run folder, the agent file, the session file and the report as full links, beside the PR link.

## Running without a sandbox

To run Pi and the checks directly on the host, add `--sandbox none` to `orc run`, as in `orc run task.md --sandbox none`.
`--sandbox nono`, the default, keeps the nono sandbox.
Without a sandbox the run still gets its own worktree on its own branch, and nono need not be on the PATH.
Pi runs with your own environment, so it can read and write anything your user can.
On a Pi login provider Pi also reads your Pi config.
On a token file provider Pi reads the run's own Pi folder instead, as [Configuring providers](#configuring-providers) describes.
Orc points `GIT_CONFIG_GLOBAL` at a file in the run folder, so the commit identity Sandcastle sets never reaches your `~/.gitconfig`.
Pi writes its session straight into the run's `sessions/host` folder.
Resume takes the sandbox from the earlier run, so `orc run --branch <name>` resumes it without a sandbox.

## Configuring providers

Orc ships with no provider and no model, so a run needs `config.json` in `$ORC_HOME`, default `~/.orc/config.json`.
It names each provider orc may run and, under `models`, the implementer and fixer models.
This example names opencode-go through a Pi login and anthropic through a token file:

```json
{
  "providers": [
    { "id": "opencode-go", "credential": "pi-login", "nono": { "upstream": "https://opencode.ai/zen/go/v1" } },
    { "id": "anthropic", "credential": "token-file", "tokenFile": { "env": "ANTHROPIC_TOKEN_FILE" } }
  ],
  "models": { "implementer": "opencode-go/muse-spark-1.3-contributor", "fixer": "opencode-go/muse-spark-1.3-contributor" }
}
```

Each provider names its Pi provider `id`, the part of a model name before the `/`, and its `credential`:

- `pi-login` checks the Pi login for that provider before the run, as [Running a task](#running-a-task) describes.
  Its `nono` entry names the `upstream` URL the nono sandbox proxies with that login's key.
  Its `nono` entry may name `injectHeader` and `credentialFormat`.
  `injectHeader` names the HTTP header the proxy fills with the key and defaults to `Authorization`.
  `credentialFormat` names the header value with `{}` where the key goes and defaults to `Bearer {}`.
  A login provider without a `nono` entry runs only with `--sandbox none`.
- `token-file` reads the token from a file, whose absolute path `tokenFile` takes from the variable `env` names or from `path`.
  `orc run --token-file <path>` takes the path from the flag instead.
  The nono sandbox carries only a Pi login, so a token file provider runs only with `--sandbox none`.

Orc refuses a `config.json` key it does not know, so a misspelled key never drops a provider unnoticed.
Orc refuses `--token-file` on a provider that takes a Pi login.
`orc run --provider <id>` refuses a run whose implementer model is on another provider, so a token meant for one provider never reaches another.
Orc refuses a token file that is unset, relative, missing, empty, not a regular file or readable by other users.
On a token file provider, Pi reads the run's own Pi folder instead of yours.
So a login stored in your Pi config never stands in for the token.
The run's `models.json` names the token file only through `ORC_TOKEN_FILE`.
Pi reads the file when it calls the provider and holds the token only in memory, so no run file keeps it.
Orc never copies, moves or deletes the token file.
A provider defined only in the operator's Pi models.json is not carried into a run directory, so use a provider Pi knows built in.

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

With the default sandbox, the sandbox reads the system folders, the Homebrew and `/usr/local` program folders and `/nix`.
It also reads the one mise install folder each of `bun`, `node` and `pi` resolves to.
With the default sandbox, orc refuses a runtime the PATH finds anywhere else, naming the runtime and its path.
To run a runtime from another install folder, such as the one Bun's own installer makes in your home:

1. Set `ORC_TOOLCHAIN_DIRS` to the install folders, separated by colons.
1. Run the task as usual.

With the default sandbox, orc grants a named folder only when a runtime and the file its link points to both sit inside it.
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
`dispatch.json` names each machine, its slots, its start command and its renew command, and the quota.
The quota names the provider its accounts belong to, the command that reads their room, and each account's token file or token command.
A token file account needs only a start command on each machine.
A token command account names a renew command on each machine beside its start command.
It also names the floor of room each account must keep:

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc", "runner", "start"] },
    { "name": "linux-box", "slots": 4, "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"] }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [
      { "name": "main", "tokenFile": "/Users/me/.secrets/main-token" },
      { "name": "second", "tokenFile": "/Users/me/.secrets/second-token" }
    ],
    "floorPercent": 15
  }
}
```

The provider is a token-file provider in `config.json` on each machine that runs the tasks.
Each token file path in `dispatch.json` holds on those machines.
A token command account keeps its token in the runner token folder on each machine instead.
Orc runs the quota command with no input and reads its standard output as this document:

```json
{
  "schema": "orc.quota.v1",
  "accounts": [
    { "name": "main", "remainingPercent": 40 },
    { "name": "second", "unusable": "the login expired" }
  ]
}
```

Each entry gives the percent of room left, from 0 to 100, or the reason the account cannot run.
An account the document does not name cannot run.
A command that exits non-zero, runs past 15 seconds or prints any other document leaves the quota unread, and the beat starts nothing.

An account can name a `tokenCommand` instead of a `tokenFile`, for a token that lives on the dispatching machine and rolls over.
Then every machine names a `renew` command beside its `start` command:

```json
{
  "machines": [
    {
      "name": "linux-box",
      "slots": 4,
      "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"],
      "renew": ["orc", "runner", "renew", "--", "ssh", "linux-box", "orc"]
    }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [{ "name": "main", "tokenCommand": ["orc", "runner", "token", "/Users/me/profiles/main/session-token.json"] }],
    "floorPercent": 15
  }
}
```

Orc runs the token command with no input and reads its standard output as this document:

```json
{ "schema": "orc.token.v1", "token": "<the token>", "expiresAt": "2027-01-01T00:00:00.000Z" }
```

The token is printable ASCII with no space, since Pi reads it with `cat` and trims it.
A token running out within five minutes counts as lapsed.
A command that exits non-zero, runs past 15 seconds or prints any other document or a lapsed token leaves the account waiting.
The beat then starts nothing on it.
A later beat that reads a live token starts the task.
A refusal names only the command and what it missed, never the token.

`orc runner token <session-token.json>` is a token command for a clauth profile.
It prints the profile's access token and expiry as `orc.token.v1`, and writes only into a pipe, never onto a terminal.
It refuses a session that still holds a refresh token, since that login would then leave the machine.
Run `clauth rolling-token` on the profile first.

`projects.json` names each project and its checkout on each machine:

```json
{ "projects": [{ "name": "orc", "checkouts": { "mac": "/Users/me/code/orc", "linux-box": "/home/me/code/orc" } }] }
```

To add a task, run `orc backlog add <project> <task-file>`.
Add `--machine <name>` to run the task on that machine only, and `--depends-on <task-id>` once per task it waits for.
To see the backlog, run `orc backlog`.
It prints the new, taken and closed tasks side by side with the project list and each machine's busy slots beside them.
To print the same facts as JSON, run `orc backlog --json`, whose document names its version first as `orc.backlog.v1`.
To start what can start, run `orc beat`, from launchd or cron every few minutes.
Each beat runs the quota command and reads the room on each machine before it takes any task.
A task starts only once three things hold:

1. Every task it depends on closed done.
2. Its project has a checkout on a machine with a free slot.
3. An account has room at or above the floor, and the runs take the account with the most room.

The beat moves the task file from `new` to `taken` before it runs the start command, so of two beats only one takes a task.
After the claim survives a recount, the beat writes the task started before it runs the start command.
A task marked for a machine waits for a slot on that machine and never starts on another.
The start command reads the task from `ORC_TASK_ID`, `ORC_TASK_FILE`, `ORC_TASK_PROJECT`, `ORC_TASK_CHECKOUT`, `ORC_TASK_MACHINE`, `ORC_TASK_PROVIDER`, `ORC_TASK_ACCOUNT` and `ORC_TASK_TOKEN_FILE`.
`ORC_TASK_TOKEN_FILE` is the account's token file path, never the token.
On a token command account it is empty, and the start command reads the token as `orc.token.v1` on standard input instead.
The beat starts it detached in its own session, never waits for it and never kills it.
So the start command and what it leaves running outlive the beat, even when launchd or cron ends the beat's process group.
Its output goes to `~/.orc/backlog/logs/<task-id>.log`, which `ORC_TASK_LOG` names.
From then on the task is the start command's to close, and one that fails leaves the task started until it is closed.
A missing start command exits 127 into its log and leaves the task started.
Only a failure to spawn the log wrapper closes the task as `start-failed`.
To print the beat as JSON, run `orc beat --json`, whose document names its version first as `orc.beat.v1`.
When a started task ends, run `orc backlog close <task-id> <done|failed> [reason]`.
On a token command account, each beat first sends every started task its account's current token through its machine's `renew` command, as JSON on standard input.

## The runner

`orc runner start` is the start command that hands a task to pueue on its machine.
The run then outlives the beat, the dispatcher and any SSH link to it.
It reads the task from the beat's `ORC_TASK_*` variables and queues `orc run` in the checkout on branch `orc/<task-id>`, in the pueue group `orc`.
The run takes `--sandbox none --provider <provider> --token-file <path>`, so it runs on the picked account and refuses an implementer on any other provider.
The group's parallel limit caps the orc runs on that machine, and they never wait behind other groups.
The runner creates the `orc` group when the machine lacks it.
The task file goes to `~/.orc/runner/<task-id>.md` on that machine, and the run reads it from there.
A task queued for another home keeps a scoped file instead, so two homes holding the same task id never share one file.
A task pueue already holds in group `orc` is not queued again.

To start on another machine, put the command that runs orc there after `--`, as in `orc runner start -- ssh linux-box orc`.
That runs `orc runner queue` on the far side and sends it the task as JSON on stdin, so the task text never passes through a remote shell.
SSH can drop once pueue holds the run, since pueue on that machine owns it.
Pueue runs the task with the environment of the command that queued it.
So the command after `--` must give orc the `PATH` its runs need on that machine.
The queue records the resolved absolute `ORC_HOME` with the task.

A task that comes with a token instead of a token file keeps it in `~/.orc/runner/tokens/<task-id>/token`, readable only by its owner, beside the expiry in `expires-at`.
A task queued for another home keeps its token under a scoped folder instead, so two homes holding the same task id never share one token.
Pueue then runs `orc runner hold <task-id> -- orc run ... --token-file <that file>`, and the hold runs the run.
The hold starts the run only while the token is live, and otherwise waits for a fresh one.
Pi reads the token once per process.
So a run that fails after its token ran out starts again on the fresh token instead of failing the task.
The queue starts a detached guard that waits for the pueue task to finish and then removes the token folder.
The guard covers the whole queued life of the task.
It removes the folder when the run succeeds, fails, is killed, or never starts.
It leaves the folder when pueue itself is unreachable, so the run still has its token after a daemon restart.
A `pueue kill` gives the hold no time to clean up, so the guard removes the folder after pueue reports the task done.

`orc runner renew` reads a task and its fresh token as JSON on standard input and replaces the token the task holds.
Add `--` and the command that runs orc on another machine to send it there, as with `orc runner start`.
A renewal for a task pueue no longer runs is refused and removes that task's token folder.

To read how a task's run went, run `orc runner result <task-id>` on its machine, or `orc runner result <task-id> -- ssh linux-box orc` from another.
The forwarded read defaults to that home's label, and `orc runner result <task-id> --label <label>` reads another home's run instead.
It names pueue's state for the task and the orc run on `orc/<task-id>` with its PR.
A task is queued, stashed, running, paused, succeeded or failed, or unknown when no pueue task in group `orc` holds it.
To print the same facts as JSON, add `--json`, whose document names its version first as `orc.runner.v1`.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/bin.ts` | The orc entry point |
| `src/args.ts` | The flag parsing for the orc command |
| `src/run.ts` | The `orc run` agent step: checkout checks, agent files and the Pi run in the selected sandbox |
| `src/orc-config.ts` | The reading of `config.json`: the providers and the agent models |
| `src/json-file.ts` | The JSON config file reading and its `ConfigError` |
| `src/model-route.ts` | The choice of the configured provider for the agent models and the check of a token file |
| `src/sandbox-plan.ts` | The per-provider preflight: the Pi login check, the model windows and the run's Pi folder |
| `src/run-record.ts` | The terminal run report, its evidence files and the `report.md` write |
| `src/history-write.ts` | The history checkpoints a run records as each step starts and ends |
| `src/report.ts` | The `report.md` shape and the signal facts it carries |
| `src/show.ts` | The `orc show` reading of one run from the history |
| `src/run-session.ts` | The reading of the Pi session from the host sessions folder |
| `src/pi.ts` | The Pi agent command, its prompt and the check of its final reply |
| `src/agents.ts` | The agent file parsing and lookup |
| `src/context-mark.ts` | The 150 thousand token compaction mark orc writes into the run's Pi folder |
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
| `src/dispatch/quota.ts` | The quota reading from the configured command and the pick of an account |
| `src/dispatch/beat.ts` | The beat: room, placement, take and start |
| `src/dispatch/board.ts` | The terminal board and the `orc.backlog.v1` and `orc.beat.v1` JSON |
| `src/dispatch/runner.ts` | The runner: the start and the token renewal through pueue |
| `src/dispatch/runner-result.ts` | The reading of a task's result and the `orc.runner.v1` JSON |
| `src/dispatch/token.ts` | The `orc.token.v1` document, the token command and the clauth session reading |
| `src/dispatch/held-token.ts` | The owner-only token folder a run on another machine reads |
| `src/dispatch/hold.ts` | `orc runner hold`: the wait for a live token, the rerun and the folder removal |
| `src/dispatch/pueue-status.ts` | The pueue status shapes and the held-task lookup the runner reads |
| `src/dispatch/args.ts` | The flag parsing for `orc backlog`, `orc beat` and `orc runner` |
| `src/dispatch/cli.ts` | The `orc backlog`, `orc beat` and `orc runner` commands |
| `../../tests/unit` | The in-process unit tests at the workspace root |
| `../../tests/e2e` | The tests that run `src/bin.ts`, git or nono as a process, with a live Pi run through `ORC_PI_E2E=1`, at the workspace root |
| `../../tests/fixtures/runner/pueue` | The pueue 4 status JSON the runner tests read |
| `../../tests/live` | The tests that run a real nono sandbox with `ORC_NONO_E2E=1` set, or the host's Pi, through the `test:live` script at the workspace root |
| `../../.no-mistakes.yaml` | The check commands no-mistakes and CI run at the workspace root |
