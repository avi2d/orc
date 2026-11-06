# session-quota

Session quota estimates how much of each subscription quota window every agent session on this machine has spent.
It reads the Pi logs under `HOME`, the Codex logs under `CODEX_HOME`, or `~/.codex`, and the Claude Code logs under `CLAUDE_CONFIG_DIR`, or `~/.claude`.
Those are the homes of the logins `quota-axi` reads.
It counts each model call once.
It splits a window's used points across the sessions that made those calls.
It flags each live session spending over its fair share of a window that runs ahead of pace and is past its first tenth.
It flags only when the window runs out before its reset.
Quota-axi's runway gives the verdict for a window it names.
An early or unknown projection leaves the live rate to decide.
A runway naming another window means this one runs to its reset.
A harvested window or one with no runway reads its pace from its live sessions' total rate against the sustainable rate.
A window with nothing left runs out before its reset.
It never pauses, stops or reroutes a session.
A session's fair share is what its window has left an hour, split evenly among the live sessions that spent in the trailing hour.
A session that has ended is never flagged.
It also reads the capture ledger that its writer appends to from a Pi hook and the Claude Code statusline.
The bridge appends headless readings to the same ledger.
Every number is an estimate from local logs and an upper bound, never a quota reading.
It can merge a second machine's report, so an account both machines spend shows one estimate instead of two upper bounds.

## Before you begin

- Bun, at the version `.bun-version` pins.
- `quota-axi` 0.1.56 on the `PATH`, since the windows the harness logs do not cover come from `quota-axi --full --json --provider`.
- Optionally `TUI_DASH_SAVED_PROFILES`, the shell command that prints the saved profiles, since the Claude account title comes from the active one, as the [tui-dash guide](../../docs/tui-dash.md#show-saved-profiles) tells.
- `herdr` 0.9.5 on the `PATH` to name live sessions by pane, since the tool reads `herdr agent list` and changes nothing in Herdr.
- `/proc` on Linux or `lsof` on macOS to find headless Pi, Claude Code and Codex processes.

## Install

To install session quota, run `bun install --frozen-lockfile` at the repository root.

## Where things are

| Path | What it holds |
| --- | --- |
| `packages/session-quota/src/sessions.ts` | The panel rows |
| `packages/session-quota/src/app.ts` | The live panel, the printed frame, the JSON report and the alert stream |
| `packages/schema/src/sessions/ledger.ts` | The count of model calls with every dedupe rule |
| `packages/schema/src/sessions/live.ts` | Session identity from Herdr panes, processes and ended logs |
| `packages/schema/src/views/session-quota.ts` | Shares, pace, fair share and the flag gate |
| `packages/schema/src/contract/session-quota.ts` | The report and alert schemas |
| `packages/schema/src/contract/composed-session-quota.ts` | The composed report schema |
| `packages/schema/src/contract/session-quota-view.ts` | A machine's report read back as a view |
| `packages/schema/src/views/composed-session-quota.ts` | The merge of two machines' views |
| `packages/schema/src/sources/remote-sessions.ts` | The configured command that reads the other machine's report |
| `packages/session-quota/src/notes.ts` | The warning notes, the other machine's among them |
| `packages/session-quota/src/capture.ts` | The writer the hooks call |
| `packages/schema/src/sessions/capture.ts` | The ledger's records, their reading back and the merge with the logs |
| `packages/schema/src/sources/capture-ledger.ts` | The ledger's day files, appended and read |

## Troubleshooting

### Every live session reads as ended

The panel shows a warning that Herdr gave no panes or that there is no process table.
Install `herdr` and check `herdr agent list` answers on the `PATH` the panel runs on.

### A headless run reads as ended

The panel shows a warning naming the pids that share the run's log folder.
Logs never name their process.
Two runs of one harness in one folder, or a run beside a Herdr pane of its harness, cannot be told apart.
Run each headless session in its own working directory, or in a Herdr pane.

### The panel says the other machine is unreachable

The configured command failed, and the line under the warning gives its reason, such as `sh exited 255` from ssh.
Run `sh -c "$TUI_DASH_REMOTE_SESSION_QUOTA"` on this machine and check that its stdout is the version 1 report alone.

### The panel says the other machine answered minutes ago

The command printed a report generated more than five minutes before this machine's read.
Check that the command runs the other machine's `--json` rather than reading a saved copy, and that both clocks are right.

### A window reads none logged here while its points rise

The calls that spent it ran on another machine or through a harness whose logs this machine does not hold.
The report counts those points in `unattributedPoints`.
To count the other machine's calls, configure it as [Compose two machines](../../docs/session-quota/compose-two-machines.md) describes.

## Related topics

- [Run the session panel](../../docs/session-quota/run-the-session-panel.md)
- [Read the JSON report](../../docs/session-quota/json-report.md)
- [Compose two machines](../../docs/session-quota/compose-two-machines.md)
- [Tail the alert stream](../../docs/session-quota/alert-stream.md)
- [Capture usage as it happens](../../docs/session-quota/capture.md)
- [The tui-dash dashboard](../../docs/tui-dash.md)
