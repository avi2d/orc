---
kind: reference
---
# Read the JSON report
To print the report once, run `tui-dash report session-quota`.
The report is one JSON object on one line, and `SessionQuotaReport` in `packages/schema/src/contract/session-quota.ts` decodes it.
A reader checks `schemaVersion` first, and version 1 is the only version.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | The ISO instant of the read |
| `scope` | `local`, since the report covers only the machine it ran on |
| `estimate` | `basis` `local-logs`, `upperBound` `true`, and the `priceRatios` of input, output, cache read and cache write tokens |
| `sources` | The status of the `quota`, `herdr` and `processes` reads, each `ok`, `unreachable` or `invalid` with a `detail`, and a herdr not installed reads `ok` with no panes, the same as an installed herdr that lists none |
| `ledger` | How many bridge copies, repeated lines, empty rows, fork copies and repeated Codex counts the count dropped, and the `unjoinedCalls` no account took |
| `accounts` | Each account with its `provider`, `accountKey`, `credentialKey`, `accountKeys`, `title`, the `joins` that put calls on it and its `quota` read status |
| `accounts[].credentialKey` | The account's own credential key, which stays the same whichever source read the account: the harness's native login, `codex-home` for Codex or `default` for Claude, when the account holds it, or else the first of quota-axi's `accountKeys` |
| `accounts[].accountKeys` | Every credential key quota-axi lists for the account, so composition can tell that two machines reading one subscription under different credentials read one account |
| `windows` | Each tracked window with its account, start, reset, used and left points, pace, `elapsedFraction` and `gate` |
| `windows[].gate` | `aheadOfPace`, `pastFirstTenth`, and `open` when both hold |
| `windows[].exhaustsBeforeReset` | Whether the window runs out before its reset, from the quota-axi verdict or the live sessions' total rate |
| `windows[].verdict` | The quota-axi verdict for the window, `null` when the live rate decides instead |
| `windows[].source` | `quota-axi` with its `readAt`, or `harvested` with the `harness`, `via` `log`, `statusline` or `headless`, the `observedAt` of the reading, its `file` and the `join` that put it on the account |
| `windows[]` pace fields | `sustainablePointsPerHour`, the live burning `activeSessions` and the `fairPointsPerHour` each of them gets, both rates `null` once the window's reset has passed |
| `windows[].observed` | The calls and measured tokens the logs hold for the window |
| `windows[].unattributedPoints` | Used points the local logs cannot explain |
| `windows[].sessions` | Each session's calls, measured `tokens`, `trailingHourTokens`, `raw` and `priced` estimates, `models` and `flagged` |
| `windows[].sessions[].models` | Each model the session called in the window, most tokens first, with its `model`, `calls`, `tokens`, `trailingHourTokens` and `priced` estimate, whose points add up to the session's |
| `raw` and `priced` | `share` of the window's local calls, `contributionPoints` as an upper bound, and `pointsPerHour` over the trailing hour |
| `sessions` | Each session's `id`, `kind`, `live`, `pane` or `pid`, `harness`, `cwd`, `place`, `label`, log `files` and `modelsSinceMidnight` |
| `sessions[].modelsSinceMidnight` | Each model the session called since local midnight on the machine that wrote the report, most tokens first, with its `model`, `tokens` and billing `provider`, across every route and quota reset |
| `unmatchedProcesses` | Each log folder whose headless processes no log could be matched to, with its `harness`, `cwd`, `place` and `pids` |
| `flags` | Each flagged session with its account, window, priced points per hour, fair points per hour and both shares |
| `unmetered` | Calls on routes no subscription meters, such as an API key, with their tokens |

A report written before window sources and credential keys has no `windows[].source`, `accounts[].credentialKey` or `accounts[].accountKeys`, and still reads.
Its windows count as read by quota-axi at its `generatedAt`.
A report written before the capture ledger has no `windows[].source.via`, and its harvested windows read as read from a log.
A report written before per-model rows has no `windows[].sessions[].models`, and its rows read as naming no model.
A model is `null` where the log names none, as a Codex rollout's token counts do.
A report written before them has no `sessions[].modelsSinceMidnight`, and its sessions read as naming no model since midnight.
A `modelsSinceMidnight` entry written before billing attribution has no `provider`, and it reads with no provider.

A session `id` is `pane:<pane id>` for a Herdr pane, `pid:<pid>` for a headless process, and `file:<log path>` for a session that ended.
Raw weighs every token alike, and priced weighs them by `estimate.priceRatios`.
The ranking and the flag use the priced estimate.
