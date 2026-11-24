---
kind: reference
---
# The heavy queue
Without `through` set, each machine queues its heavy shell calls through one pueue group named `heavy` with one slot.
Heavy calls are test runs, builds and browser runs through tools like `bun`, `bunx`, `npm`, `npx`, `pnpm`, `yarn`, `vitest`, `playwright`, `jest`, `go`, `cargo`, `node`, `python`, `python3`, `uv`, `make`, `deno`, `pytest`, `tsc`, `oxlint`, `eslint`, `xcodebuild` and `xcrun`.
The queue keeps two such calls from overloading the machine at the same time.

## How calls reach the queue
`orc run` and `orc runner start` write a stand in into `~/.orc/heavy/bin` for each heavy tool and configured command.
For `python`, `python3`, `uv`, `deno`, `go`, `cargo`, and `make`, orc writes a stand in only when the tool exists on `PATH`.
Shell probes still find those tools absent when they are missing.
Other tools get stand ins even without a `PATH` binary, so the helper can run the nearest `node_modules/.bin` copy.
Each write removes stand ins for commands no longer configured and for those seven tools when they disappear from `PATH`.
A stand in is a launcher of three shell lines that starts orc's TypeScript helper through the absolute path of its bun.
`orc run` puts that folder on `PATH` for the agent it starts, after only `~/.orc/heavy/ci-only`.
A stand in queues the call with `pueue add` into the `heavy` group, or hands it to the `through` command when one is set, and waits for its turn, then prints the call output and exits with its exit code.
Without `through` set, the wait message names how many queued calls stand ahead, counting higher priority calls and earlier calls at the same priority.
Without `through` set, a finished call leaves the queue after the stand in reads its exit code.
The stand in runs the real tool under a utility priority on macOS and with no wrapper on other systems.

## Run the real tool

The helper runs the real tool once the queue hands it the turn.

The helper finds the tool, decides whether the call queues, and runs, queues or waits for it, and never decides through itself.
The helper stays the caller's process for the whole call, passes the tool's exit code back, and passes on a stop or hangup signal to the tool.
It reads no `.env` or `bunfig.toml` from the caller's folder.
If the bun or helper is gone, the launcher warns once on stderr to rerun orc and runs the recorded tool with no queue, or the nearest node_modules/.bin copy above the working folder when orc recorded no path.
A queued call runs under the same helper in its pueue task, which stops the call once the stand in that queued it is gone.
A stand in runs the first copy of the tool on its caller's PATH that is not an orc stand in, then the absolute path recorded when orc wrote it, then the nearest node_modules/.bin copy above the working folder that is not an orc stand in, and refuses with exit 127 when none exists.
Without `through` set, a call that a queued call starts runs at once instead of queuing again.
The stand in trusts the process tree above the call, never an exported group variable on its own.
Set `HEAVY_QUEUE_BYPASS` to a reason to skip the queue for one command, and the reason is logged to the alerts file and counted by the check command.
Without `through` set, under `GITHUB_ACTIONS` a queued call waits up to 30 minutes, then fails with the queue length in its message.

## Targeted runs first
A targeted test run queues with priority, so a single file check runs ahead of whole suite runs.
A run counts as targeted when it names a test filter flag, a test file or a package path.
A bare word counts as a named file for `bun test`, `vitest` and `jest`.
A `watch`, `ui` or `dev` script never queues.
Whole suite runs queue with no priority and wait their turn.

## Check the queue
Run `orc heavy path` to create the stand ins and print the folder.
Without `through` set, run `orc heavy check` to read slots, running calls, queued calls with their ages, and bypasses.
Without `through` set, run `orc heavy check --json` for the same report as JSON.
Without `through` set, run `orc runner load` to print the load with the queued count and the week's bypasses that the beat reads.
Without `through` set, run `orc heavy watch` to arm the watchdog that reports stalled calls and queue slips.
Without `through` set, run `orc heavy watch-once` to run one watchdog pass and print its counts.

## Tune the queue
The `heavy` key in `~/.orc/config.json` tunes the queue.
The `group` key renames the pueue group.
The `commands` key adds command words that count as heavy, including subcommands of the built in tools.
The `limit` key takes `auto` or `none`, and `none` runs the real tool with no priority wrapper.
The `through` key hands each queued call to a queue command you already run instead of pueue, as the next section says.

## Queue through another command
Set `through` to the words of a command that holds one slot and then runs the command it is given, such as `"through": ["winbox-heavy", "run", "--"]`.
A stand in then runs `winbox-heavy run -- <real tool> <args>` in place of `pueue add`, so the calls that command already limits and the calls from the stand ins share one limit.
On macOS under `limit` `auto` the priority wrapper sits between the through words and the real tool.
The real tool's output reaches the caller as it prints, and the stand in exits with the through command's exit code.
A heavy call started under a call the through command holds runs at once instead of waiting on the slot it holds.
Calls that never queue and calls under `HEAVY_QUEUE_BYPASS` skip the through command too.
The through command owns the wait, so the 30 minute limit under `GITHUB_ACTIONS` does not apply.
With `through` set, orc makes no pueue group and arms no watchdog.
With `through` set, `orc heavy watch` prints a line naming the through command and arms no watchdog.
With `through` set, `orc heavy check` and `orc heavy watch-once` fail with a line naming the through command.

## Test runs in agent sessions
`orc run` sets `HEAVY_TESTS_CI_ONLY=1` for the steps it starts: `prepare`, the local checks and the Pi agent, under the [nono](https://nono.sh) sandbox and under `--sandbox none`.
For those steps it also writes stand ins for `node` and `checks-test` into `~/.orc/heavy/ci-only`, even without a `PATH` binary.
It puts that folder first on `PATH`, ahead of `~/.orc/heavy/bin`.
A `ci-only` stand in never queues: it refuses a test run, or runs the next `node` or `checks-test` on `PATH`.
Under that variable a stand in refuses a test run with exit 1 and a line naming the command, and leaves the tests to GitHub CI.
A test run is one of these calls, watch and UI runs included:
- `bun test`, `npm t`, `node --test`, `go test`, `cargo test`, and `cargo t`.
- `python -m pytest`, `python3 -m pytest`, `uv run pytest`, and `uv run python -m pytest`, including flags before the runner.
- `make` with a `test` or `check` target, and `deno test`.
  A `make` option value named `test` or `check` is not a test target.
- A `test`, `tests`, `test:*`, `e2e` or `e2e:*` script, or a script named `vitest`, `jest` or `pytest`, through `bun`, `npm`, `pnpm` or `yarn`.
- `checks-test`, `vitest`, `jest`, `pytest` or `playwright test`, directly or through `bunx`, `npx`, `bun x`, or a manager's `exec` or `dlx`.
- `bun` or `node` starting the bin file of `checks-test`, `checks-flake`, `checks-mutation`, `stryker`, `vitest`, `jest` or `playwright test`.

Under `--sandbox none` every other call, such as a build, a lint or a typecheck, queues as it does without the variable.
Under the nono sandbox it runs at once, as the next section says.
The checks of a run go through the same stand ins, so a check command that starts a test run fails.

### Runners behind a package manager
A package manager puts `node_modules/.bin` ahead of every stand in, so a script body that names a runner skips the runner's own stand in.
That runner's bin file starts `bun` or `node` through its first line, and the stand in for that runtime reads the file it starts.
So a package script, a shell wrapper or a workspace-selected script that reaches a runner is refused too.

### Bun runtime overrides
`--bun`, its `-b` alias and `[run] bun = true` in `bunfig.toml` make Bun put its own `node` and `bun` links ahead of the stand-ins on `PATH`.
Under `HEAVY_TESTS_CI_ONLY=1`, the Bun stand-in refuses `--bun` and `-b` in `bun`, `bun run`, `bun x` and `bunx`.
It also refuses package script and bin-name calls when the effective `bunfig.toml` sets `[run] bun = true`, `bun check` included, because a package script named `check` runs in place of Bun's built-in.
The stand-in finds that file from the call's working directory, `--cwd` and `--config`.
A file call runs when its path starts with `/`, `./` or `../`, in both `bun <file>` and `bun run <file>`.
A `bun <file>` call on a bare path that ends in `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` or `.cts` runs too.
Every other file call is refused, such as `bun run` on a bare path or `bun` on a `.sh` file, because Bun gives it the same `node` link.

### What is not blocked
- A `node` runner started from a Yarn 1 or Yarn Berry script, which puts a `node` wrapper first on the script's `PATH`, though no run has confirmed that route.
- A runner started through a runtime's absolute path.
- A runner the list does not name.
- The [no-mistakes](https://github.com/kunchenguid/no-mistakes) review and fix agents, unless the no-mistakes config starts them through orc's agent wrapper, as the next section says.

## The no-mistakes review and fix agents
The no-mistakes daemon starts its review and fix agents with the daemon's own environment, never with the environment of the shell that runs `no-mistakes axi run`.
So `HEAVY_TESTS_CI_ONLY=1` and the stand-in folders that `orc run` sets for its own steps never reach those agents.

`orc heavy path`, `orc run` and `orc runner start` write an agent wrapper for `claude`, `codex`, `opencode` and `pi` into `~/.orc/heavy/agents`.
A wrapper sets `HEAVY_TESTS_CI_ONLY=1`, puts `~/.orc/heavy/ci-only` and `~/.orc/heavy/bin` first on `PATH`, and starts the real agent.
It starts the first copy of the agent on the daemon's `PATH` that is not the wrapper itself.
If no such copy exists, it exits 127 with a line naming the agent.

The review and fix agents refuse test runs only when `~/.no-mistakes/config.yaml` holds `agent_path_override.<agent>` pointing at `~/.orc/heavy/agents/<agent>`, where `<agent>` is the agent no-mistakes runs.
On the maintainer's machines, the skills repository generates that config.
Orc never writes that global file itself.
To check whether the key is there, run `grep agent_path_override ~/.no-mistakes/config.yaml`.
Where that config is not generated, add the key by hand.
The example below is for a home folder of `/home/you` whose config already chooses `agent: pi`.
Keep your own `agent` value, and put its name in place of `pi` under `agent_path_override` and in the path:

```yaml
agent: pi
agent_path_override:
  pi: /home/you/.orc/heavy/agents/pi
```

no-mistakes reads `agent_path_override` only from that global file, so it applies to every repository the daemon gates on the machine.
Every review and fix agent it starts then refuses a test run as the list above says, and its builds, lints and typechecks queue through the stand-ins.
Run `orc heavy path` once before the next no-mistakes run, so the wrapper exists.

## Sandboxed runs
Under the default nono sandbox, orc puts `~/.orc/heavy/ci-only` and `~/.orc/heavy/bin` first on the agent's `PATH`, ahead of the runtime folders.
The nono profile grants read and no write of both folders, the helper's folder and the bun file that starts the helper.
The sandbox grants no pueue socket, so it also sets `HEAVY_QUEUE_UNREACHABLE=1`, and under that variable a call that is not refused runs at once.

## Watch the queue
`orc runner start` arms the watchdog beside the alert stream unless `through` is set.
The watchdog reports only the local machine.
A running targeted call older than 10 minutes writes a `long-task` alert, once per machine per 10 minutes.
A heavy tool process outside a running `heavy` task writes a `heavy-slip` alert naming the command, once per command per 10 minutes.
