---
kind: reference
---
# Capture usage as it happens
The writer `tui-dash-capture` appends one record to the capture ledger each time a hook calls it.
The ledger keeps Claude statusline and headless readings, which no log keeps, and Pi calls whose log was rotated or deleted.
The readers prefer the ledger where it holds a call, and count from the logs where it does not.

## Build the writer

Run `bun run build` at the repository root.
The build writes `packages/session-quota/dist/capture-bin.js`, a single file that starts without the repository's modules.
Hooks run `bun packages/session-quota/dist/capture-bin.js` with the kind of record as its one argument and the record's input on stdin.
The writer exits 0 after it handles a record, even when it captures nothing.
`--help` prints usage and exits 0.
An unknown flag prints usage and exits 1.
When it cannot capture, it prints one line that starts with `tui-dash-capture:` to stderr and writes nothing.
It gives up after 2 seconds, so a hook that never closes stdin costs the agent nothing.

## Capture a Pi call

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

## Capture Claude readings from the statusline

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

## Capture headless readings from the bridge

The `pi-claude-bridge` appends one headless reading to the ledger for each SDK `rate_limit_event` it sees.
Each entry carries `kind` `claude-headless-reading`, the ISO instant `at`, the bridge session id `sessionId`, the config folder it ran under as `claudeHome`, and the `five_hour` and `seven_day` `windows` it could use.
Each window carries `window`, `usedPercent` as a whole percent and ISO `resetsAt`.
The bridge reads `utilization` as a fraction from the event's `unifiedWindows` and stores a hundred times that, rounded.
It reads each window's `resetsAt` in seconds from the same event.
It leaves out any window that names neither number, and it writes nothing when no window names both.
The readers count a headless reading only for the login under the same config folder.
The bridge appends one entry for each SDK event, so each headless reading counts as fresh even when its numbers match the previous one.

## Read the ledger

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
