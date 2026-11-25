---
kind: how-to
---
# orc-dash

`orc-dash` opens terminal panels for quota, machine resources, tasks, and other orc data.

## Before you begin

The release executables run without Bun.
The tools below are optional.
A panel reports a missing tool without stopping the rest of the screen.

| Optional tool | Used for |
| --- | --- |
| `quota-axi` 0.1.56 | Quota windows not in harness logs |
| `nvidia-smi` | NVIDIA GPU usage |
| [`herdr`](https://herdr.dev) 0.9.5 | Agent sessions named by pane |
| `pueue` 4.0.4 | Queued and running jobs |
| [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) | Full review fix stages |
| `orc` | Orc run stages, the attention queue and the dispatch accounts |
| `gh` | GitHub Actions and runner repositories |

Put the tools you use on `PATH`.
For GPU usage on WSL, the panel also checks `/usr/lib/wsl/lib`.
Sign in to `gh` with an account that can read the repository.

The tasks report and second machine each require a shell command you configure.
They are off until configured.

## Install

To install `orc-dash` and `orc-dash-capture`:

1. Download the archive for your platform and its checksum from the [Orc releases on GitHub](https://github.com/avi2d/orc/releases).
1. Check the archive's checksum as [Release assets](run/release-assets.md#checksum-file) describes.
1. Unpack the archive into a folder outside `PATH`.
1. Copy only `orc-dash` and `orc-dash-capture` into a folder on `PATH`.
1. Run `orc-dash --help` and `orc-dash-capture --help` to check that both commands start.

If you use a versioned launcher, see [Updating orc](run/updating-orc.md#update-a-versioned-checkout) for how to follow its selected release.

## Open one panel

Run `orc-dash panel --list` to see the available panels.
Run `orc-dash panel quota` to open the quota panel, or replace `quota` with another panel name.
Press `q` or Control C to quit.
In the clone, `bun run dashboard panel quota` runs the same panel.

Add `--print` to print one frame instead of opening the live panel.
Use `--width 120 --height 30` to set its size and `--color` for ANSI colours.
The `--color` flag works only with `--print`.
Each panel reads its settings from its key under `panels` in the [dashboard configuration](dash-dashboard.md#configure-the-dashboard).

## Panel guides

<div id="run-the-quota-tool"><span id="show-each-claude-account"></span></div>

[Quota](dash-quota.md) shows account limits.
It shows the [dispatch accounts](dash-quota.md#show-the-dispatch-accounts) from `orc quota --json`.
Configure [Claude accounts](dash-quota.md#show-each-claude-account).

<div id="run-the-session-quota-tool"></div>

[Session quota](session-quota/run-the-session-panel.md) shows usage by session.

<div id="run-the-resources-tool"><span id="show-a-second-machine-s-resources"></span><span id="read-the-resources-report"></span><span id="read-the-tasks-block"></span></div>

[Resources](dash-resources.md) shows machine usage.
See [the second machine](dash-resources.md#show-the-resources-of-a-second-machine), [the resources report](dash-resources.md#read-the-resources-report), and [its tasks block](dash-resources.md#read-the-tasks-block).

<div id="run-the-queues-tool"><span id="run-the-dispatch-tool"></span></div>

[Queues](dash-queues.md) shows pueue and GitHub Actions.
[Dispatch](dash-dispatch.md) shows the backlog and machine slots.

<div id="run-the-attention-tool"></div>

[Attention](run/attention-queue.md#run-the-attention-tool) shows questions that need answers.

<div id="run-the-tasks-tool"><span id="read-the-tasks-report"></span><span id="follow-a-task-s-stages"></span><span id="keep-the-task-history"></span></div>

[Tasks](dash-tasks.md) shows projects and tasks.
See [stages](dash-tasks.md#follow-the-stages-of-a-task), [history](dash-tasks.md#keep-the-task-history), and [the tasks report](dash-tasks.md#read-the-tasks-report).

<div id="run-the-dashboard"><span id="use-a-wide-screen"></span><span id="follow-the-ledger"></span><span id="fill-the-ledger"></span><span id="configure-the-dashboard"></span><span id="lay-out-the-dashboard"></span><span id="set-the-colours"></span></div>

[Dashboard](dash-dashboard.md) covers the screen, [ledger](dash-dashboard.md#follow-the-ledger), [layout](dash-dashboard.md#lay-out-the-dashboard), and [colours](dash-dashboard.md#set-the-colours).

<div id="take-a-snapshot"><span id="read-the-snapshot"></span></div>

[Snapshot](dash-snapshot.md) captures current readings.

<div id="watch-for-alerts"><span id="configure-the-alerts"></span><span id="read-the-alert-events"></span><span id="record-a-verdict"></span><span id="read-the-alerts-panel"></span></div>

[Alerts](dash-reports.md) covers [rules](dash-reports.md#configure-the-alerts), [events](dash-reports.md#read-the-alert-events), [verdicts](dash-reports.md#record-a-verdict), and [the panel](dash-reports.md#read-the-alerts-panel).

## Development

<div id="run-the-checks"><span id="find-the-code"></span></div>

See [Develop orc-dash](dash-development.md) for checks and source paths.

## Troubleshooting

### The panel shows an unreachable line for every provider

The quota tool could not start `quota-axi`.
Install it and check that it runs on the panel machine's `PATH`.

### The quota panel's accounts block shows an error

Run `orc quota --json` and check its output.

### The other machine's resources panel says it is unreachable

The panel reports why the configured command failed, such as `sh exited 255` from SSH.
Run `sh -c "$ORC_DASH_REMOTE_RESOURCES"` locally and check that its output contains only the version 1 report.

`sh exited 127` means the remote shell could not find `bun`.
Put Bun's folder on the remote `PATH`, for example `cd orc && PATH=$HOME/.bun/bin:$PATH bun run resources-json`.
A full path to the first `bun` is not enough because the script invokes `bun` again by name.
