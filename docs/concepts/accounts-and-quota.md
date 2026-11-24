---
aside: false
pageClass: wide-page part-quota
kind: explanation
---
# Accounts and quota

Orc chooses the account a run spends by reading how much room each account has left, and it takes the one with the most.
You name the accounts and the command that reads their room once, in the `quota` part of `dispatch.json`.

![Accounts and quota: which account a run spends](../diagrams/quota.svg)

## The quota command

Each beat runs the quota command with no input, before it takes any task.
The command prints one JSON document with an entry for each account.
The entry gives the percent of room left, from 0 to 100, or the reason the account cannot run.
Orc reads three shapes: its own `orc.quota.v1` document, the document `quota-axi --full --json --provider <id>` prints, and the `subquo.v1` snapshot `subquo read --json` prints.
A command that is not installed, fails, runs past 15 seconds or prints anything else leaves the quota unread, and that beat starts nothing.

To read quota from subquo, set the quota command to `["subquo", "read", "--json"]`.
To go back, set the quota command back to the value it held before, the reader that prints an `orc.quota.v1` or quota-axi document.
An account's room in a subquo snapshot is the smallest `percentLeft` among its windows with scope `all`.
A window that covers one model only does not limit the account.
An account whose reading is stale, unavailable, past its `validUntil` or has an unknown percent or reset cannot run.
A quota account the snapshot does not name leaves the whole quota unread, since the subquo account list and the quota accounts then differ.

## The choice

An account can run when its room is above 0% and at or above `floorPercent`.
Without a `floorPercent` there is no floor.
Among the accounts that can run, the beat picks the one with the most room, and the tasks that beat starts take it.
An account an `orc.quota.v1` or quota-axi document does not name cannot run.

The quota names a default provider, and an account may name its own, so one quota can hold Claude, OpenAI and OpenCode accounts.
The beat compares every account in the quota, whatever its provider, and the run it starts takes the picked account's provider.
Each provider is one `~/.orc/config.json` defines on each machine that runs tasks.
An account's provider comes from its `provider` in `dispatch.json`, never from the vendor a `subquo.v1` snapshot names for it.

The models in `~/.orc/config.json` serve the quota's provider.
An account on another provider names its own implementer and fixer models from that provider, and the run it starts takes them.
Orc refuses a `dispatch.json` with an account on another provider that names no models, or a model from a provider other than the account's.

## How the credential reaches the run

The account's kind says where its credential lives.

| Kind | What the beat hands the run |
| --- | --- |
| `token-file` | The path of a token file that exists on the machine, never the token |
| `token-command` | A token the command prints, sent on standard input and renewed each beat |
| `claude-config` | The path of that account's Claude config directory on the machine |
| `none` | Nothing, since the provider's own package logs in |

A token command account is for a token that lives on the dispatching machine and rolls over.
The runner keeps it in a folder only its owner can read and removes the folder when the run ends.

## Related topics

- [The beat](beat.md)
- [The runner](runner.md)
- [The backlog and the beat](../run/backlog-and-beat.md)
- [Configuring providers](../run/configuring-providers.md)
