---
kind: reference
---
# Compose two machines
The panel, the printed frame and the dashboard merge a second machine's sessions when a command that prints that machine's report is configured.
The command runs on this machine and prints the other machine's `--json` report, the version 1 report above.
Only that usage-only report crosses between machines, never a log line or a prompt.

To configure the second machine, set these variables where the panel runs:

| Variable | What it holds |
| --- | --- |
| `ORC_DASH_REMOTE_SESSION_QUOTA` | The shell command that prints the other machine's report, such as `ssh other-host 'bun orc/packages/cli/src/bin.ts report session-quota'` |
| `ORC_DASH_REMOTE_MACHINE` | The other machine's name on its rows, `remote` when unset |
| `ORC_DASH_MACHINE` | This machine's name on its rows, `local` when unset |

With `ORC_DASH_REMOTE_SESSION_QUOTA` unset or blank, the panel reads this machine alone.
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

## Read the composed report

To print the merged report once, run `orc-dash report session-quota-composed`.
It prints this machine's report alone, in the composed shape, when no second machine is configured.
`ComposedSessionQuotaReport` in `packages/schema/src/entities/session-quota/contract/composed-session-quota.ts` decodes it.
Its `schemaVersion` is `2`, so a reader of the version 1 report never mistakes one for the other.
`orc-dash report session-quota` prints this machine's version 1 report alone, and the alert stream reads this machine alone.

The composed report keeps the fields of the version 1 report, except `sources`, and changes these:

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `2` |
| `scope` | `composed` |
| `estimate.basis` | `machine-logs`, and `upperBound` stays `true` |
| `machines` | Each machine's `name`, `role` `local` or `remote`, `status` `ok`, `unreachable`, `invalid` or `stale` with a `detail`, `generatedAt` and whether its calls are `combined` |
| `machines[].sources` | The `sources` the machine read, as in the version 1 report |
| `machines[].failedAccounts` | Each account the machine could not read, with its `quota` status, where the merged account does not already carry that failure |
| `windows[].otherCycle` | The machines that read the window in another cycle, so their calls are left out of it |
| `machine` | On each entry of `sessions`, `windows[].sessions`, `flags` and `unmatchedProcesses` |
| `ledger` and `unmetered` | The sums over every combined machine |
