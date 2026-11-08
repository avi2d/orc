# session-quota

Session quota estimates how much of each subscription quota window every agent session on this machine has spent.
It flags each live session spending over its fair share of a window that runs out before its reset.
Every number is an estimate from local logs and an upper bound, never a quota reading.

## Before you begin

- Bun, at the version `.bun-version` pins.
- `quota-axi` 0.1.56 on the `PATH`, since the windows the harness logs do not cover come from `quota-axi --full --json --provider`.
- Optionally `TUI_DASH_SAVED_PROFILES`, the shell command that prints the saved profiles, since the Claude account title comes from the active one, as the [tui-dash guide](../../docs/tui-dash.md#show-saved-profiles) tells.
- Optionally `herdr` 0.9.5 on the `PATH` to name live sessions by pane, since the tool reads `herdr agent list` and changes nothing in Herdr.
  Without it, live sessions show from their processes and logs.
- `/proc` on Linux or `lsof` on macOS to find headless Pi, Claude Code and Codex processes.

## Install

To install session quota, run `bun install --frozen-lockfile` at the repository root.

## Run the panel

To open the live panel, run `tui-dash panel session-quota`.
To print one frame of plain text instead, run `tui-dash panel session-quota --print`.
[Run the session panel](../../docs/session-quota/run-the-session-panel.md) names every key and option.

## Where things are

| Path | What it holds |
| --- | --- |
| `packages/session-quota/src/sessions.ts` | The panel rows |
| `packages/session-quota/src/app.ts` | The live panel, the printed frame, the JSON report and the alert stream |
| `packages/schema/src/sources/ledger.ts` | The count of model calls with every dedupe rule |
| `packages/schema/src/sources/live.ts` | Session identity from Herdr panes, processes and ended logs |
| `packages/schema/src/views/session-quota.ts` | Shares, pace, fair share and the flag gate |
| `packages/schema/src/contract/session-quota.ts` | The report and alert schemas |
| `packages/schema/src/contract/composed-session-quota.ts` | The composed report schema |
| `packages/schema/src/views/session-quota-view.ts` | A machine's report read back as a view |
| `packages/schema/src/views/composed-session-quota.ts` | The merge of two machines' views |
| `packages/schema/src/views/remote-sessions.ts` | The configured command that reads the other machine's report |
| `packages/session-quota/src/notes.ts` | The warning notes, the other machine's among them |
| `packages/session-quota/src/capture.ts` | The writer the hooks call |
| `packages/schema/src/sources/capture.ts` | The ledger's records, their reading back and the merge with the logs |
| `packages/schema/src/sources/capture-ledger.ts` | The ledger's day files, appended and read |

## Related topics

- [Run the session panel](../../docs/session-quota/run-the-session-panel.md)
- [Read the JSON report](../../docs/session-quota/json-report.md)
- [Compose two machines](../../docs/session-quota/compose-two-machines.md)
- [Tail the alert stream](../../docs/session-quota/alert-stream.md)
- [Troubleshoot the session panel](../../docs/session-quota/troubleshoot.md)
- [Capture usage as it happens](../../docs/session-quota/capture.md)
- [The tui-dash dashboard](../../docs/tui-dash.md)
