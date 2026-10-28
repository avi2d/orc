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

## Run the session panel

To run the live panel, run `tui-dash panel session-quota`.
The panel paints again every 30 seconds and says `reading local session logs…` until the first read of the logs finishes.
It fits the terminal's rows by showing fewer sessions a window, and it keeps every flagged session in view.
Below one row a window, it shows the flags first and then whatever notes still fit.
When two lines a flag do not fit, each flag takes one line with its session, window cycle and account.
When even one line a flag does not fit, the panel shows the flags that fit.
Its last line counts the rest and names the repository root's `session-quota-json` script, which lists every flag, or `session-quota-composed-json` when a second machine is composed.
A terminal too narrow for that line on one row wraps it onto two.
Heights under eight rows are not a supported layout, so there that line can be cut, and the script still lists every flag.
The dashboard shows only the flags, each naming the agent's project, the account and the limit.
Each account opens with the assumption that joined its calls to it, such as joined by credential key or assumed the only login.
A window is read from a harness log when the log covered its provider within the hour, or read it later than quota-axi did.
Such a window names that log and the reading's age, such as from codex rollout 38m ago.
It names the reading's join too when that differs from the account's.
An account read from a harness log stands for the credential that log ran under.
A call keyed to another credential of that provider joins no account.
When quota-axi fails, each provider it was asked about shows the failure under its own heading.
The accounts read from harness logs keep their windows and flags.
Each window lists its sessions ranked by price weighted share, with the raw share, the upper bound in points and the points per hour.
Points per hour above 999 read >999, and the JSON report holds the exact rate.
A live session reads ● and an ended one ○, and a flagged session reads ⚑.
A window with a flagged session reads over fair share flagged.
It reads lasts to reset instead when the window is not running out before its reset.
It reads none over fair share when the window runs out but no session carries a flag.
A window with no local calls reads none logged here, and its used points count as unattributed.
A window quota-axi still reports after its reset reads unknown pace, shows no fair share, counts only the calls before its reset, and flags nobody.
A window read an hour old or more reads its age instead of its used points, fair share and pace.
Such a window reads 7d window read 13h 0m ago, for example.
Its sessions keep their shares, drop the points and points per hour, and none is flagged.
The trailing hour is the hour before the read, its first instant included.
A window past its reset holds no trailing-hour spend once that reset is an hour past.
A headless process takes its folder's newest log only when it is the only process of its harness there.
It also needs no Herdr pane of that harness to name a log there or run there.
Otherwise the panel names the processes that share the folder, and the folder's logs read as ended.
Press `q` or Control C to quit.

To print one frame of plain text instead, run `tui-dash panel session-quota --print`, and add `--width 40` for a narrow frame.

## Read the JSON report

To print the report once, run `tui-dash report session-quota`.
The report is one JSON object on one line, and `SessionQuotaReport` in `packages/schema/src/contract/session-quota.ts` decodes it.
A reader checks `schemaVersion` first, and version 1 is the only version.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `generatedAt` | The ISO instant of the read |
| `scope` | `local`, since the report covers only the machine it ran on |
| `estimate` | `basis` `local-logs`, `upperBound` `true`, and the `priceRatios` of input, output, cache read and cache write tokens |
| `sources` | The status of the `quota`, `herdr` and `processes` reads, each `ok`, `unreachable` or `invalid` with a `detail` |
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

## Compose two machines

The panel, the printed frame and the dashboard merge a second machine's sessions when a command that prints that machine's report is configured.
The command runs on this machine and prints the other machine's `--json` report, the version 1 report above.
Only that usage-only report crosses between machines, never a log line or a prompt.

To configure the second machine, set these variables where the panel runs:

| Variable | What it holds |
| --- | --- |
| `TUI_DASH_REMOTE_SESSION_QUOTA` | The shell command that prints the other machine's report, such as `ssh other-host 'bun tui-dash/packages/cli/src/bin.ts report session-quota'` |
| `TUI_DASH_REMOTE_MACHINE` | The other machine's name on its rows, `remote` when unset |
| `TUI_DASH_MACHINE` | This machine's name on its rows, `local` when unset |

With `TUI_DASH_REMOTE_SESSION_QUOTA` unset or blank, the panel reads this machine alone.
The command runs through `sh -c` with a 90 second limit, beside this machine's own read.
Its stdout must be that report alone, whitespace aside, so a login banner or anything else the command prints goes to stderr.

Two machines' accounts of one provider are one account when they share any key either carries.
Those keys are the `accountKey`, the `credentialKey`, the `accountKeys` and the key of each `credential-key` join.
Accounts linked through a chain of shared keys are one account too.
An account that carries no key joins the provider's one keyed account, and stands alone beside two.
When no account of the provider carries a key, the keyless ones are one account.
Their windows merge when they share the window id and their resets fall within a minute of each other.
This machine's quota reading supplies the used points, the pace and the gate of a merged window.
Each session's share is then of the calls both machines observed, so the shares of one window add up to its used points once.
The live sessions that spent in the trailing hour on either machine split the fair share, and each session over its fair share of a window running out before its reset is flagged.
Used points neither machine explains stay unattributed, and every share stays an upper bound, since claude.ai and any third machine spend unseen.
An account or window that only one machine reads shows as that machine read it.
Every flag in the other machine's report is judged again by the fair share rule above.
So a report flagging by an older rule shows only the sessions over their fair share of a window running out before its reset.
A window the other machine read in another cycle, around a reset, keeps this machine's calls alone and reads, for example, `south read another cycle`.

Each session row starts with its machine's name, because pane ids repeat across machines.
A row too narrow for the whole name keeps the letters that tell the machines apart.
It keeps as many as fit beside the pane id, which always stays whole.
Short names leave the row more room for the place.
A window neither machine logged a call in reads, for example, `none logged on north or south`.
The caption names the machines whose logs the estimates come from, such as `estimates from north and south logs`.
When the command fails or its output is not a version 1 report, the panel says so on a warning line with the reason.
It does the same when the report is more than five minutes old.
It then shows this machine's shares alone, as upper bounds, under a caption that names only this machine.
When this machine's quota-axi reading fails, the other machine's accounts and the accounts the harness logs read still show.
A warning line says that calls on the accounts quota-axi reads are not counted, with the reason.
When one machine's read of an account fails and the other machine reads its windows, those windows still show.
A warning line beside them names the machine and the account, with the reason.

### Read the composed report

To print the merged report once, run `tui-dash report session-quota-composed`.
It prints this machine's report alone, in the composed shape, when no second machine is configured.
`ComposedSessionQuotaReport` in `packages/schema/src/contract/composed-session-quota.ts` decodes it.
Its `schemaVersion` is `2`, so a reader of the version 1 report never mistakes one for the other.
`tui-dash report session-quota` prints this machine's version 1 report alone, and the alert stream reads this machine alone.

The composed report keeps the fields of the version 1 report, except `sources`, and changes these:

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `2` |
| `scope` | `composed` |
| `estimate.basis` | `machine-logs`, and `upperBound` stays `true` |
| `machines` | Each machine's `name`, `role` `local` or `remote`, `status` `ok`, `unreachable`, `invalid` or `stale` with a `detail`, `generatedAt`, whether its calls are `combined`, the `sources` it read, and its `failedAccounts`, each account it could not read, with its `quota` status, where the merged account does not already carry that failure |
| `windows[].otherCycle` | The machines that read the window in another cycle, so their calls are left out of it |
| `machine` | On each entry of `sessions`, `windows[].sessions`, `flags` and `unmatchedProcesses` |
| `ledger` and `unmetered` | The sums over every combined machine |

## Tail the alert stream

To stream alerts, run `tui-dash report session-quota-alerts`.
The stream reads again every 30 seconds and prints one JSON object per line, only when a flag rises or clears.
Its first read prints a `flagged` line for each flag already up.
`SessionQuotaAlert` in `packages/schema/src/contract/session-quota.ts` decodes each line.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `event` | `flagged` when a session goes over its fair share of a window running out before its reset, `cleared` when it stops being over it |
| `at` | The ISO instant of the read that saw the change |
| `flag` | The same object as an entry of the report's `flags` |

Each session's flag rises and clears on its own, so two sessions over their share of one window print two `flagged` lines.
A flag follows its account's `credentialKey`, so an account read from a harness log on one read and from quota-axi on the next raises no edge.
A supervisor reads it line by line, as in `tui-dash report session-quota-alerts | while read -r line; do ...; done`.

## Capture usage as it happens

The writer `tui-dash-capture` appends one record to the capture ledger each time a hook calls it.
The ledger keeps Claude statusline and headless readings, which no log keeps, and Pi calls whose log was rotated or deleted.
The readers prefer the ledger where it holds a call, and count from the logs where it does not.

### Build the writer

Run `bun run build` at the repository root.
The build writes `packages/session-quota/dist/capture-bin.js`, a single file that starts without the repository's modules.
Hooks run `bun packages/session-quota/dist/capture-bin.js` with the kind of record as its one argument and the record's input on stdin.
The writer exits 0 after it handles a record, even when it captures nothing.
`--help` prints usage and exits 0.
An unknown flag prints usage and exits 1.
When it cannot capture, it prints one line that starts with `tui-dash-capture:` to stderr and writes nothing.
It gives up after 2 seconds, so a hook that never closes stdin costs the agent nothing.

### Capture a Pi call

Run the writer with `pi-call` from a Pi extension on every `message_end` event whose message role is `assistant`.
Its stdin is one JSON object with these fields:

| Field | Where the extension takes it from |
| --- | --- |
| `sessionId` | `ctx.sessionManager.getSessionId()` |
| `sessionFile` | `ctx.sessionManager.getSessionFile()`, or `null` for a session kept in memory |
| `cwd` | `ctx.cwd` |
| `provider`, `model`, `timestamp` and `usage` | The same fields of `event.message` |

The writer keeps `input`, `output`, `cacheRead` and `cacheWrite` of `usage` and drops every other field.
It writes nothing for a message with no usage.

### Capture Claude readings from the statusline

Run the writer with `claude-statusline` from the Claude Code statusline command, and pass it the statusline's stdin unchanged.
The writer keeps `session_id`, `cwd`, `cost.total_api_duration_ms` and the `five_hour` and `seven_day` windows of `rate_limits`.
It drops the model, the cost, the context window and every other field.
It writes nothing before Claude Code's first response, when the statusline carries no rate limits.
It writes nothing while `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects the account, since no Claude home names that account.
It checks only whether those variables are set and never writes their values.
A reading names the Claude home it was taken under, `CLAUDE_CONFIG_DIR` or `~/.claude`.
The readers count it only for the login under the same home.
Claude Code reruns the statusline every `refreshInterval` seconds with its last response's numbers.
So the writer skips a reading that repeats the session's last one, and the readers date a repeat by the first time it was seen.

### Capture headless readings from the bridge

The `pi-claude-bridge` appends one headless reading to the ledger for each SDK `rate_limit_event` it sees.
Each entry carries `kind` `claude-headless-reading`, the ISO instant `at`, the bridge session id `sessionId`, the config folder it ran under as `claudeHome`, and the `five_hour` and `seven_day` `windows` it could use.
Each window carries `window`, `usedPercent` as a whole percent and ISO `resetsAt`.
The bridge reads `utilization` as a fraction from the event's `unifiedWindows` and stores a hundred times that, rounded.
It reads each window's `resetsAt` in seconds from the same event.
It leaves out any window that names neither number, and it writes nothing when no window names both.
The readers count a headless reading only for the login under the same config folder.
The bridge appends one entry for each SDK event, so each headless reading counts as fresh even when its numbers match the previous one.

### Read the ledger

The ledger is a folder of one JSON Lines file a UTC day, such as `2026-10-17.jsonl`.
It lives in `$XDG_STATE_HOME/tui-dash/usage`, or in `~/.local/state/tui-dash/usage` when `XDG_STATE_HOME` is not set.
Only the user may read the folder and its files.
The writer deletes a day file once it is more than 32 days old.
That keeps the start of a 31 day month window in the ledger.
`CaptureRecord` in `packages/schema/src/sessions/capture.ts` decodes each line.

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `pi-call`, `claude-code-reading` or `claude-headless-reading` |
| `at` | The ISO instant the writer ran |
| `sessionId` | The session's id |
| `cwd` | The session's working directory, which a reading may leave `null` |
| `sessionFile` | For `pi-call`, the Pi session file, or `null` |
| `provider` and `model` | For `pi-call`, the names Pi gave them |
| `messageAt` | For `pi-call`, the ISO instant Pi stamped on the message |
| `tokens` | For `pi-call`, `input`, `output`, `cacheRead` and `cacheWrite` |
| `claudeHome` | For `claude-code-reading` and `claude-headless-reading`, the Claude home or config folder it was taken under |
| `totalApiDurationMs` | For `claude-code-reading`, Claude Code's API time so far, which grows only when a response arrives |
| `windows` | For `claude-code-reading` and `claude-headless-reading`, each window's `window`, `usedPercent` and ISO `resetsAt` |

The ledger holds no prompt, message body, credential or token value.
A Pi call in both the ledger and its Pi log is the same message stamp with the same usage, so it counts once.
A Pi `claude-bridge` call in the ledger still drops its Claude Code copy, as the same call in the Pi log does.
A statusline reading stands for its Claude window in the quota panel the way a log reading does, and the panel says `from claude code statusline`.
A headless reading stands for its Claude window the same way, and the panel says `from claude code headless`.
In the JSON report, a ledger window sets `source.via` to `statusline` or `headless`, and a log window sets it to `log`.

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
To count the other machine's calls, configure it as [Compose two machines](#compose-two-machines) describes.
