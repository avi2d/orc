---
kind: reference
---
# Tail the alert stream
To stream alerts, run `orc-dash report session-quota-alerts`.
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
A supervisor reads it line by line, as in `orc-dash report session-quota-alerts | while read -r line; do ...; done`.
